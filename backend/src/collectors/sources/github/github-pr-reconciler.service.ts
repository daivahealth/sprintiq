import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { evaluateBudget } from './github-rate-budget';
import { GithubClient } from './github.client';

export interface PrStatsReconcileResult {
  candidates: number;
  updated: number;
  skipped: number;
  rateLimited: boolean;
  /** PRs whose detail has still never been fetched — re-run to continue. */
  remaining: number;
  /** When the next run can make progress (hard limit, or our own reserve). */
  resumeAt?: Date;
}

/**
 * One-off maintenance: fills in additions/deletions/changedFiles for
 * `code_pull_request` rows still at the default 0/0/0 — PRs ingested before
 * `GithubCollector`'s per-PR enrichment existed, or ones that outran its
 * bounded per-tick budget. Updates rows directly, bypassing the normal
 * event-sourced ingestion pipeline: a PR's idempotency key makes its stats
 * permanent once first ingested, so a corrective re-ingestion attempt would
 * just be dropped as a duplicate — this is the only way to correct data
 * already landed. The token never leaves the backend: resolved
 * per-connection via SecretsService, never returned or logged.
 */
@Injectable()
export class GithubPrReconcilerService {
  private readonly logger = new Logger(GithubPrReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly client: GithubClient,
  ) {}

  async reconcile(
    tenantId: string,
    limit = 200,
  ): Promise<PrStatsReconcileResult> {
    const candidateWhere = {
      tenantId,
      // Asked once, never again. Some rows can never be satisfied — a PR with a
      // genuinely empty diff stays at 0/0/0, and one merged by a since-deleted
      // account has `merged_by: null` forever. Without this guard they remain
      // candidates permanently, which is harmless for a hand-run endpoint and
      // an unbounded API drain once this runs on a schedule.
      detailFetchedAt: null,
      OR: [
        // Never enriched for line-change stats.
        { additions: 0, deletions: 0, changedFiles: 0 },
        // Merged but we don't know who merged it. `merged_by` lives only on
        // this same detail response, and `self_merge_rate` is uncomputable
        // without it — a PR backfilled for reviews alone never got it.
        { state: 'merged', mergedBy: null },
      ],
    };

    const candidates = await this.prisma.pullRequest.findMany({
      where: candidateWhere,
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

      const detail = await this.client.getPullRequestDetail(
        pr.repoFullName,
        token,
        pr.externalNumber,
      );
      const budget = evaluateBudget(detail);
      if (budget.exhausted) {
        rateLimited = true;
        resumeAt = budget.resumeAt;
        reserved = budget.reserved;
        break;
      }
      if (
        detail.additions === undefined &&
        detail.deletions === undefined &&
        detail.mergedBy === undefined
      ) {
        // The request came back with nothing usable (a 404 on a deleted repo,
        // say). Not stamped — a failed read must stay a candidate.
        skipped++;
        continue;
      }

      await this.prisma.pullRequest.update({
        where: { id: pr.id },
        data: {
          // Stats are only overwritten when the response actually carried
          // them — a PR selected purely for its missing `mergedBy` must not
          // have good stats reset to 0.
          ...(detail.additions !== undefined || detail.deletions !== undefined
            ? {
                additions: detail.additions ?? 0,
                deletions: detail.deletions ?? 0,
                changedFiles: detail.changedFiles ?? 0,
              }
            : {}),
          ...(detail.mergedBy ? { mergedBy: detail.mergedBy } : {}),
          // Asked and answered — even if the answer was "still 0 lines" or
          // "no known merger". This is what terminates the scheduled sweep.
          detailFetchedAt: new Date(),
        },
      });
      updated++;
    }

    const remaining = await this.prisma.pullRequest.count({
      where: candidateWhere,
    });

    this.logger.log(
      `Reconciled PR stats: ${updated} updated, ${skipped} skipped, ${remaining} remaining` +
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
