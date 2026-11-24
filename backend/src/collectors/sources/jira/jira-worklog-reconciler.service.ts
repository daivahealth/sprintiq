import { Injectable, Logger } from '@nestjs/common';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import { JiraClient } from './jira.client';
import { collectIssueWorklogs, worklogEnvelope } from './jira-worklogs';

export interface WorklogReconcileResult {
  candidates: number;
  /** Issues whose worklog set reached the ingestion pipeline. */
  collected: number;
  /** Of those, sets read only in part — applied upsert-only, retried next run. */
  partial: number;
  /** Stories whose missing creator was filled. */
  creatorsFilled: number;
  /** Issues Jira did not return (deleted or moved out of view). */
  absent: number;
  skipped: number;
  rateLimited: boolean;
}

/** One `key in (...)` search fetches 100 issues — the search's `maxResults` cap. */
const BATCH_SIZE = 100;
/**
 * Bounds one invocation. Each batch is one search plus one worklog fetch per
 * issue carrying more than the 20 the search embeds, so this is a request
 * budget in practice, not just a row budget. A larger backlog catches up over
 * backfill ticks, the same shape as the other reconcilers.
 */
const MAX_BATCHES = 10;

/**
 * Backfills Jira worklogs and issue creators (ADR-0014, Sprint Health Efforts)
 * for work items collected before either was requested.
 *
 * The same watermark trap as `JiraStoryDateReconcilerService`: the issue
 * envelope's idempotency key derives from the issue's `updated` timestamp, so
 * re-walking an unchanged issue is dropped as a duplicate and fixes nothing.
 *
 * Two differences from that reconciler, both deliberate:
 *
 *  - **Worklogs go through the ingestion pipeline**, not straight into the
 *    table. They are new source data, so they belong in the raw-event store
 *    with their lineage, and the worklog envelope's key is a hash of the set's
 *    content (`worklogEnvelope`) — so this path and the poller converge on the
 *    same raw event for the same set instead of the trap above.
 *  - **The creator is written directly**, like the story date: it is one
 *    immutable field of an issue already in the store, and an envelope for it
 *    would duplicate the whole issue payload.
 *
 * Terminates: a row stops being a candidate once a COMPLETE set has been read
 * for it (the projector stamps `worklogsCollectedAt`), or once Jira no longer
 * returns the issue at all (stamped here — nothing more can be learned). A set
 * read only in part stays a candidate and is retried; that is bounded by Jira,
 * not by this loop.
 *
 * Newest items first, so the sprints people are looking at fill before
 * history does. The token never leaves the backend.
 */
@Injectable()
export class JiraWorklogReconcilerService {
  private readonly logger = new Logger(JiraWorklogReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly client: JiraClient,
    private readonly ingestion: IngestionService,
  ) {}

  /** Items never collected with a complete worklog set — for the Sync Status backlog. */
  async countRemaining(tenantId: string): Promise<number> {
    return this.prisma.story.count({
      where: { tenantId, worklogsCollectedAt: null },
    });
  }

  async reconcile(tenantId: string): Promise<WorklogReconcileResult> {
    const candidates = await this.prisma.story.findMany({
      where: { tenantId, worklogsCollectedAt: null },
      select: {
        id: true,
        externalKey: true,
        projectKey: true,
        connectionId: true,
        creatorLogin: true,
        creatorName: true,
      },
      orderBy: [{ sourceCreatedAt: { sort: 'desc', nulls: 'last' } }],
      take: BATCH_SIZE * MAX_BATCHES,
    });

    const result: WorklogReconcileResult = {
      candidates: candidates.length,
      collected: 0,
      partial: 0,
      creatorsFilled: 0,
      absent: 0,
      skipped: 0,
      rateLimited: false,
    };

    const byConnection = new Map<string, typeof candidates>();
    for (const story of candidates) {
      const group = byConnection.get(story.connectionId) ?? [];
      group.push(story);
      byConnection.set(story.connectionId, group);
    }

    for (const [connectionId, stories] of byConnection) {
      const connection = await this.prisma.connection.findUnique({
        where: { id: connectionId },
      });
      const config = (connection?.config ?? {}) as {
        siteUrl?: string;
        email?: string;
      };
      // Tenant-checked as well as looked up: a story's connection id must never
      // lead this tenant's run to another tenant's credential.
      if (
        !connection ||
        connection.tenantId !== tenantId ||
        !config.siteUrl ||
        !config.email
      ) {
        result.skipped += stories.length;
        continue;
      }
      const apiToken = await this.secrets.resolve(
        tenantId,
        connection.secretRef,
      );
      if (!apiToken) {
        result.skipped += stories.length;
        continue;
      }

      for (let i = 0; i < stories.length; i += BATCH_SIZE) {
        const batch = stories.slice(i, i + BATCH_SIZE);
        const keyList = batch
          .map((s) => `"${s.externalKey.replace(/"/g, '')}"`)
          .join(',');
        const page = await this.client.searchIssues(
          config.siteUrl,
          config.email,
          apiToken,
          {
            jql: `key in (${keyList})`,
            maxResults: BATCH_SIZE,
            fields: ['worklog', 'creator'],
          },
        );
        if (page.rateLimitedUntil) {
          result.rateLimited = true;
          break;
        }
        if (page.failed) {
          // Never read as "these issues have no worklogs" — they stay
          // candidates for the next run.
          this.logger.warn(
            `Jira rejected a worklog batch for connection ${connectionId} — leaving ${batch.length} rows for a re-run.`,
          );
          result.skipped += batch.length;
          continue;
        }

        const issues = new Map(page.issues.map((issue) => [issue.key, issue]));
        for (const story of batch) {
          const issue = issues.get(story.externalKey);
          if (!issue) {
            // Deleted, or moved out of the account's view. Nothing more can be
            // learned, so it stops being a candidate; any worklogs already
            // stored stay, since their absence here is not evidence of deletion.
            await this.prisma.story.update({
              where: { id: story.id },
              data: { worklogsCollectedAt: new Date() },
            });
            result.absent++;
            continue;
          }

          if (!story.creatorLogin && !story.creatorName) {
            const creator = issue.fields?.creator as
              | { name?: string; accountId?: string; displayName?: string }
              | undefined;
            const creatorLogin = creator?.name ?? creator?.accountId;
            if (creatorLogin || creator?.displayName) {
              await this.prisma.story.update({
                where: { id: story.id },
                data: {
                  creatorLogin: creatorLogin ?? null,
                  creatorName: creator?.displayName ?? null,
                },
              });
              result.creatorsFilled++;
            }
          }

          const set = await collectIssueWorklogs(
            this.client,
            config.siteUrl,
            config.email,
            apiToken,
            story.externalKey,
            issue.fields?.worklog,
          );
          if (!set) {
            // The site returned no `worklog` field at all (time tracking
            // disabled or hidden). Asked and answered: stamp it so it stops
            // being a candidate, without inventing an empty set.
            await this.prisma.story.update({
              where: { id: story.id },
              data: { worklogsCollectedAt: new Date() },
            });
            result.skipped++;
            continue;
          }

          const ingested = await this.ingestion.ingest(
            tenantId,
            worklogEnvelope(
              connectionId,
              'backfill',
              story.externalKey,
              story.projectKey,
              set,
              new Date().toISOString(),
            ),
          );
          result.collected++;
          if (!set.complete) {
            result.partial++;
          } else if (ingested.status === 'duplicate') {
            // This exact complete set was ingested before — by the poller — but
            // the stamp is missing (the projector ran before the story row
            // existed, or failed; a failure is logged by the event bus and the
            // raw event stays for replay). Re-reading cannot help either way:
            // the identical key is dropped again. Stamping is what lets the row
            // stop being a candidate instead of being re-fetched every tick.
            await this.prisma.story.update({
              where: { id: story.id },
              data: { worklogsCollectedAt: new Date() },
            });
          }
        }
      }

      if (result.rateLimited) {
        break;
      }
    }

    this.logger.log(
      `Reconciled Jira worklogs: ${result.collected} collected (${result.partial} partial), ${result.creatorsFilled} creators filled, ${result.absent} absent, ${result.skipped} skipped, ${result.candidates} candidates` +
        (result.rateLimited ? ' (stopped early — rate-limited)' : ''),
    );
    return result;
  }
}
