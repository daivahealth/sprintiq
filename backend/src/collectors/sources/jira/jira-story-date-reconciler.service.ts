import { Injectable, Logger } from '@nestjs/common';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { JiraClient } from './jira.client';

export interface StoryDateReconcileResult {
  candidates: number;
  updated: number;
  skipped: number;
  rateLimited: boolean;
}

/**
 * Jira caps `key in (...)` well above this, but the search endpoint caps
 * `maxResults` at 100 — so one batch is one request either way.
 */
const BATCH_SIZE = 100;
/** Bounds one invocation; a bigger backlog needs a re-run (same shape as the GitHub reconcilers). */
const MAX_BATCHES = 200;

/**
 * One-off maintenance: fills in `story.sourceCreatedAt` for work items
 * ingested before Jira's `created` field was collected (api/README.md §12 #1).
 *
 * Why this can't be a cursor reset and a re-walk. The Jira envelope's
 * idempotency key is `jira:{issueKey}:{eventType}:{updated}` — derived from the
 * issue's own `updated` timestamp. Re-walking an unchanged issue therefore
 * produces the *identical* key, which IngestionService drops as a duplicate
 * before the event ever reaches PlanningService. So re-collection silently
 * fixes nothing: the only issues a re-walk would repair are the ones that
 * happened to change on their own, and those were never the problem. Updating
 * the rows directly is the only route, exactly as it is for GitHub's PR and
 * commit stat reconcilers.
 *
 * Batched rather than per-issue: `key in (...)` fetches 100 issues in one
 * request, so ~13k rows costs ~130 calls instead of 13,000.
 *
 * The token never leaves the backend — resolved per-connection via
 * SecretsService, never returned or logged.
 */
@Injectable()
export class JiraStoryDateReconcilerService {
  private readonly logger = new Logger(JiraStoryDateReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly client: JiraClient,
  ) {}

  /**
   * How many stories still lack Jira's own `created` date — without asking
   * Jira. Read by `CollectionProgressService` for the Sync Status backlog.
   */
  async countRemaining(tenantId: string): Promise<number> {
    return this.prisma.story.count({
      where: { tenantId, sourceCreatedAt: null },
    });
  }

  async reconcile(tenantId: string): Promise<StoryDateReconcileResult> {
    const candidates = await this.prisma.story.findMany({
      where: { tenantId, sourceCreatedAt: null },
      select: { id: true, externalKey: true, connectionId: true },
      take: BATCH_SIZE * MAX_BATCHES,
    });

    let updated = 0;
    let skipped = 0;
    let rateLimited = false;

    // Grouped by connection: each carries its own site URL, account and token.
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
      if (!connection || !config.siteUrl || !config.email) {
        skipped += stories.length;
        continue;
      }

      const apiToken = await this.secrets.resolve(
        tenantId,
        connection.secretRef,
      );
      if (!apiToken) {
        skipped += stories.length;
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
            fields: ['created'],
          },
        );
        if (page.rateLimitedUntil) {
          rateLimited = true;
          break;
        }
        if (page.failed) {
          // Never counted as "these issues have no created date" — a failed
          // request leaves them as candidates for the next run.
          this.logger.warn(
            `Jira rejected a story-date batch for connection ${connectionId} — leaving ${batch.length} rows for a re-run.`,
          );
          skipped += batch.length;
          continue;
        }

        const createdByKey = new Map<string, string>();
        for (const issue of page.issues) {
          const created = issue.fields?.created;
          if (typeof created === 'string') {
            createdByKey.set(issue.key, created);
          }
        }

        for (const story of batch) {
          const created = createdByKey.get(story.externalKey);
          // Absent means the issue was deleted or moved out of view since we
          // collected it. Left null rather than guessed — it stays excluded
          // from lead time and counted, which is the honest state.
          if (!created) {
            skipped++;
            continue;
          }
          await this.prisma.story.update({
            where: { id: story.id },
            data: { sourceCreatedAt: new Date(created) },
          });
          updated++;
        }
      }

      if (rateLimited) {
        break;
      }
    }

    this.logger.log(
      `Reconciled Jira story dates: ${updated} updated, ${skipped} skipped, ${candidates.length} candidates` +
        (rateLimited ? ' (stopped early — rate-limited)' : ''),
    );
    return { candidates: candidates.length, updated, skipped, rateLimited };
  }
}
