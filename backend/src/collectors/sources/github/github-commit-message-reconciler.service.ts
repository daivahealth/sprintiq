import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { evaluateBudget } from './github-rate-budget';
import { GithubClient } from './github.client';

export interface CommitMessageReconcileResult {
  candidates: number;
  updated: number;
  skipped: number;
  rateLimited: boolean;
  /** PRs whose commit messages have still never been fetched — re-run to continue. */
  remaining: number;
  /** When the next run can make progress (hard limit, or our own reserve). */
  resumeAt?: Date;
}

/**
 * Bounds one invocation. One GitHub call per PR, so a full run over the
 * ~2,500-PR backlog costs ~2,500 requests spread across ticks — the same
 * shape as the review reconciler, inside the 5,000/hr limit with the
 * reserve protecting the poller.
 */
const DEFAULT_LIMIT = 500;

/**
 * One-off maintenance: fetches commit subjects for pull requests ingested
 * before commit-message collection existed (api/README.md §12 #6).
 *
 * Why the normal sync will never do this. Steady-state PR sync only walks PRs
 * newer than `syncCursors.prNewestSeenAt`; every already-ingested PR sits
 * behind that watermark and is never revisited — so when `GET
 * /pulls/{n}/commits` was added to enrichment (2026-08-12), it only ever
 * applied to PRs updated afterwards, and the existing history stayed
 * permanently at `commitMessages: []`. Commit messages are one of the three
 * documented Jira-key sources (§6), and an empty list is read by correlation
 * as "carries no key" — collection absence disguised as evidence absence.
 *
 * Updates `code_pull_request` rows directly, bypassing the ingestion pipeline
 * for the same reason as the other reconcilers: the PR's idempotency key makes
 * a corrective re-ingestion a dropped duplicate. Once messages land, the
 * 30-minute orphan sweep (`CorrelationSchedulerService`) re-extracts keys from
 * the stored rows — no further call needed here.
 */
@Injectable()
export class GithubCommitMessageReconcilerService {
  private readonly logger = new Logger(
    GithubCommitMessageReconcilerService.name,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly client: GithubClient,
  ) {}

  async reconcile(
    tenantId: string,
    limit = DEFAULT_LIMIT,
  ): Promise<CommitMessageReconcileResult> {
    const candidateWhere = {
      tenantId,
      // Only rows never asked about — a PR from a since-deleted repo can
      // never be answered, and without the stamp a scheduled sweep would
      // re-fetch it every tick forever.
      commitsFetchedAt: null,
      // PRs enriched by the live collector already carry their messages —
      // re-fetching them recovers nothing.
      commitMessages: { isEmpty: true },
    };

    const candidates = await this.prisma.pullRequest.findMany({
      where: candidateWhere,
      // Newest first: recent PRs are the ones dashboards actually window on.
      orderBy: { openedAt: 'desc' },
      take: limit,
    });

    let updated = 0;
    let skipped = 0;
    let rateLimited = false;
    let resumeAt: Date | undefined;
    let reserved = false;
    const tokenCache = new Map<string, string>();

    for (const pr of candidates) {
      const connection = await this.prisma.connection.findUnique({
        where: { id: pr.connectionId },
      });
      if (!connection) {
        skipped++;
        continue;
      }

      let token = tokenCache.get(connection.id);
      if (token === undefined) {
        token =
          (await this.secrets.resolve(tenantId, connection.secretRef)) ?? '';
        tokenCache.set(connection.id, token);
      }
      if (!token) {
        skipped++;
        continue;
      }

      const result = await this.client.listPullRequestCommits(
        pr.repoFullName,
        token,
        pr.externalNumber,
      );
      if (result.rateLimitedUntil) {
        // GitHub already refused this call — nothing was fetched for this PR.
        rateLimited = true;
        resumeAt = result.rateLimitedUntil;
        break;
      }
      if (result.failed) {
        // Never stamped: an unanswered PR must stay a candidate rather than
        // be retired as "asked, and it genuinely has no messages".
        skipped++;
        continue;
      }

      await this.prisma.pullRequest.update({
        where: { id: pr.id },
        data: {
          // Zero messages is an answer too — stamp it, but leave the stored
          // (empty) list untouched rather than writing [] over it.
          ...(result.messages.length > 0
            ? { commitMessages: result.messages }
            : {}),
          commitsFetchedAt: new Date(),
        },
      });
      updated++;

      // Reserve check AFTER the write: this call's quota is already spent, so
      // stopping applies to the NEXT call, not to work already paid for.
      const budget = evaluateBudget(result);
      if (budget.exhausted) {
        rateLimited = true;
        resumeAt = budget.resumeAt;
        reserved = budget.reserved;
        break;
      }
    }

    const remaining = await this.prisma.pullRequest.count({
      where: candidateWhere,
    });

    this.logger.log(
      `Reconciled PR commit messages: ${updated} updated, ${skipped} skipped, ${remaining} remaining` +
        (rateLimited
          ? reserved
            ? ` (paused at the rate reserve — resumes ${resumeAt?.toISOString()})`
            : ` (rate-limited by GitHub — resumes ${resumeAt?.toISOString()})`
          : ''),
    );
    return {
      candidates: candidates.length,
      updated,
      skipped,
      rateLimited,
      remaining,
      resumeAt,
    };
  }
}
