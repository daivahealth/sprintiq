import { Injectable, Logger } from '@nestjs/common';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { JiraClient } from './jira.client';

export interface AssigneeEmailReconcileResult {
  /** Distinct assignees still missing an email — NOT the story count. */
  candidates: number;
  /** Assignees whose address Jira disclosed. */
  resolved: number;
  /** Story rows stamped as a result. */
  storiesUpdated: number;
  skipped: number;
  rateLimited: boolean;
  /**
   * True when Jira answered for every assignee we asked about and disclosed no
   * address for any of them — the signature of an instance with user-profile
   * visibility closed. Reported so an admin sees a setting to change rather
   * than a reconciler that appears to do nothing.
   */
  emailsWithheld: boolean;
}

/** The search endpoint caps `maxResults` at 100, so one batch is one request. */
const BATCH_SIZE = 100;
/** Bounds one invocation; a bigger backlog needs a re-run. */
const MAX_BATCHES = 20;

/**
 * Backfills `story.assigneeEmail` for work items collected before the assignee
 * email was read (api/README.md §12 #46, DATA-MODEL.md §3.1).
 *
 * Why a re-walk cannot do this — the same trap `JiraStoryDateReconcilerService`
 * documents: the Jira envelope's idempotency key is derived from the issue's
 * own `updated` timestamp, so re-collecting an unchanged issue produces the
 * identical key and is dropped as a duplicate before the projector sees it.
 * Only issues that happened to change on their own would be repaired, and those
 * were never the problem.
 *
 * **Keyed on the assignee, not the story, and that is the whole cost model.**
 * An email belongs to a person, so one representative issue per distinct
 * assignee teaches us the address for every issue they hold: ~217 assignees
 * across ~6,000 assigned stories collapses to 3 requests rather than 60. This
 * matters most in the failure case — on an instance that withholds emails every
 * assigned story is a permanent candidate, and a story-keyed reconciler running
 * on the 10-minute backfill schedule would re-ask about all of them forever
 * (the eternal-rate-limit-burn `code_pull_request.detailFetchedAt` exists to
 * prevent). Assignee-keyed, the worst case is a handful of wasted calls that
 * also produce the `emailsWithheld` signal.
 *
 * The token never leaves the backend — resolved per-connection via
 * SecretsService, never returned or logged.
 */
@Injectable()
export class JiraAssigneeEmailReconcilerService {
  private readonly logger = new Logger(JiraAssigneeEmailReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly client: JiraClient,
  ) {}

  /**
   * Distinct assignees still missing an email — without asking Jira.
   *
   * Counts PEOPLE, not stories, matching what the reconciler actually works
   * through; a story count here would report a backlog 30× the real one and
   * make the Sync Status projection meaningless.
   */
  async countRemaining(tenantId: string): Promise<number> {
    const rows = await this.prisma.story.findMany({
      where: { tenantId, assigneeLogin: { not: null }, assigneeEmail: null },
      distinct: ['assigneeLogin'],
      select: { assigneeLogin: true },
    });
    return rows.length;
  }

  async reconcile(tenantId: string): Promise<AssigneeEmailReconcileResult> {
    // One representative story per assignee: the address is a fact about the
    // person, so asking about more of their issues would return the same answer
    // at N times the cost.
    const candidates = await this.prisma.story.findMany({
      where: { tenantId, assigneeLogin: { not: null }, assigneeEmail: null },
      distinct: ['assigneeLogin'],
      select: {
        externalKey: true,
        connectionId: true,
        assigneeLogin: true,
      },
      take: BATCH_SIZE * MAX_BATCHES,
    });

    let resolved = 0;
    let storiesUpdated = 0;
    let skipped = 0;
    let rateLimited = false;
    let asked = 0;

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
            fields: ['assignee'],
          },
        );
        if (page.rateLimitedUntil) {
          rateLimited = true;
          break;
        }
        if (page.failed) {
          // Never recorded as "these people have no email" — a failed request
          // leaves them as candidates for the next run.
          this.logger.warn(
            `Jira rejected an assignee-email batch for connection ${connectionId} — leaving ${batch.length} assignees for a re-run.`,
          );
          skipped += batch.length;
          continue;
        }
        asked += batch.length;

        // accountId → disclosed email, from whichever issues came back.
        const emailByAccount = new Map<string, string>();
        for (const issue of page.issues) {
          const assignee = issue.fields?.assignee as
            | { accountId?: string; name?: string; emailAddress?: string }
            | undefined;
          const ref = assignee?.name ?? assignee?.accountId;
          if (ref && assignee?.emailAddress) {
            emailByAccount.set(ref, assignee.emailAddress);
          }
        }

        for (const [ref, email] of emailByAccount) {
          // Stamps every story this person holds, not just the representative
          // one we asked about — that is what makes the next run's candidate
          // set shrink by a person rather than by a row.
          const result = await this.prisma.story.updateMany({
            where: { tenantId, assigneeLogin: ref, assigneeEmail: null },
            data: { assigneeEmail: email },
          });
          resolved++;
          storiesUpdated += result.count;
        }
      }

      if (rateLimited) {
        break;
      }
    }

    // Jira answered about people and disclosed nobody's address: the instance
    // hides them. An admin needs to see that as a setting, not as silence.
    const emailsWithheld = asked > 0 && resolved === 0;
    if (emailsWithheld) {
      this.logger.warn(
        `Jira disclosed no assignee email for any of ${asked} assignees (tenant ${tenantId}). ` +
          'This is the expected result when user-profile visibility is restricted — the ' +
          'identity bridge falls back to display-name matching until it is opened.',
      );
    }

    this.logger.log(
      `Reconciled Jira assignee emails: ${resolved} assignees resolved, ${storiesUpdated} stories stamped, ${skipped} skipped, ${candidates.length} candidates` +
        (rateLimited ? ' (stopped early — rate-limited)' : ''),
    );
    return {
      candidates: candidates.length,
      resolved,
      storiesUpdated,
      skipped,
      rateLimited,
      emailsWithheld,
    };
  }
}
