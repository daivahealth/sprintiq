import { Injectable, Logger } from '@nestjs/common';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { newId } from '../../../common/id';
import { PrismaService } from '../../../database/prisma.service';
import { evaluateBudget } from './github-rate-budget';
import { GithubClient } from './github.client';

export interface ReviewReconcileResult {
  candidates: number;
  updated: number;
  reviewsWritten: number;
  skipped: number;
  rateLimited: boolean;
  /** PRs still awaiting a review fetch or a comment count — re-run to continue. */
  remaining: number;
  /**
   * When the next run can make progress. Set both when GitHub cut us off and
   * when we stopped voluntarily at the reserve — the scheduler waits either
   * way, so it never spends a tick discovering it has no quota.
   */
  resumeAt?: Date;
}

/**
 * Bounds one invocation. Up to TWO GitHub calls per PR (reviews, then comments
 * when there are reviews to attribute them to), so a full run costs ~1,000
 * requests — inside the 5,000/hr limit with room for the regular sync ticks,
 * but only a few runs per hour. Exhausting the quota is handled, not avoided:
 * the pass stops cleanly and `remaining` reports what is left.
 */
const DEFAULT_LIMIT = 500;

/**
 * One-off maintenance: fetches the review timeline for pull requests ingested
 * before reviews were collected (api/README.md §12 #5).
 *
 * Why the normal sync will never do this. Steady-state PR sync only walks PRs
 * newer than `syncCursors.prNewestSeenAt`; every already-ingested PR sits
 * behind that watermark and is never revisited. The review fetch itself is
 * unconditional, but the PR never reaches it — so without this, review metrics
 * would only ever cover PRs updated after the feature shipped, and the
 * existing history would stay permanently empty.
 *
 * Writes `code_pr_review` rows and the PR's derived review fields directly,
 * bypassing the ingestion pipeline for the same reason as the other
 * reconcilers: the PR's idempotency key makes a corrective re-ingestion a
 * dropped duplicate.
 *
 * Resumable by construction — a PR stops being a candidate once its reviews
 * are stamped AND their comments counted, so re-running continues where this
 * stopped rather than redoing work.
 */
@Injectable()
export class GithubReviewReconcilerService {
  private readonly logger = new Logger(GithubReviewReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly client: GithubClient,
  ) {}

  async reconcile(
    tenantId: string,
    limit = DEFAULT_LIMIT,
  ): Promise<ReviewReconcileResult> {
    // Two kinds of candidate, and missing the second is the trap this service
    // exists to avoid in the first place: a PR whose reviews were fetched
    // BEFORE comment counting existed is already stamped, so filtering on
    // `reviewsFetchedAt: null` alone would leave review_depth and
    // rubber_stamp_rate permanently empty on all existing history.
    const uncounted = await this.prisma.prReview.findMany({
      where: { tenantId, commentsCounted: false },
      select: { repoFullName: true, externalNumber: true },
      distinct: ['repoFullName', 'externalNumber'],
      take: limit,
    });

    const candidates = await this.prisma.pullRequest.findMany({
      where: {
        tenantId,
        OR: [
          { reviewsFetchedAt: null },
          ...(uncounted.length > 0
            ? [
                {
                  OR: uncounted.map((u) => ({
                    repoFullName: u.repoFullName,
                    externalNumber: u.externalNumber,
                  })),
                },
              ]
            : []),
        ],
      },
      // Newest first: recent PRs are the ones dashboards actually window on,
      // so a partial run is immediately useful rather than filling in history
      // nobody is looking at yet.
      orderBy: { openedAt: 'desc' },
      take: limit,
    });

    let updated = 0;
    let reviewsWritten = 0;
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

      const result = await this.client.listPullRequestReviews(
        pr.repoFullName,
        token,
        pr.externalNumber,
      );
      const reviewBudget = evaluateBudget(result);
      if (reviewBudget.exhausted) {
        rateLimited = true;
        resumeAt = reviewBudget.resumeAt;
        reserved = reviewBudget.reserved;
        break;
      }
      if (result.failed) {
        // Never stamped as fetched: "merged with no review" is a reportable
        // finding, so a failed request must leave the PR a candidate rather
        // than record an empty timeline as fact.
        skipped++;
        continue;
      }

      // Comment counts only matter where there is a review to attribute them
      // to, so a PR with no reviews costs one call rather than two.
      const comments =
        result.reviews.length > 0
          ? await this.client.listPullRequestReviewComments(
              pr.repoFullName,
              token,
              pr.externalNumber,
            )
          : { countByReviewId: new Map<string, number>(), truncated: false };
      const commentBudget = evaluateBudget(comments);
      if (commentBudget.exhausted) {
        rateLimited = true;
        resumeAt = commentBudget.resumeAt;
        reserved = commentBudget.reserved;
        break;
      }
      const commentsCounted = !comments.failed;

      const sorted = [...result.reviews].sort((a, b) =>
        a.submittedAt.localeCompare(b.submittedAt),
      );
      // Upsert, not createMany(skipDuplicates): a row already collected
      // without comment counts has to be UPDATED, and skipDuplicates would
      // silently leave it at 0/false forever. The update also re-classifies
      // `isBot` from GitHub's authoritative `user.type`, correcting rows the
      // migration could only classify by login suffix.
      for (const r of sorted) {
        await this.prisma.prReview.upsert({
          where: {
            tenantId_externalId: { tenantId, externalId: r.externalId },
          },
          create: {
            id: newId(),
            tenantId,
            connectionId: pr.connectionId,
            repoFullName: pr.repoFullName,
            externalNumber: pr.externalNumber,
            externalId: r.externalId,
            reviewerLogin: r.reviewerLogin ?? null,
            isBot: r.isBot,
            state: r.state,
            hasBody: r.hasBody,
            commentCount: comments.countByReviewId.get(r.externalId) ?? 0,
            commentsCounted,
            submittedAt: new Date(r.submittedAt),
          },
          update: {
            isBot: r.isBot,
            // Only overwrite counts when this run actually counted them —
            // a failed comments call must not reset a good count to 0.
            ...(commentsCounted
              ? {
                  commentCount: comments.countByReviewId.get(r.externalId) ?? 0,
                  commentsCounted: true,
                }
              : {}),
          },
        });
        reviewsWritten++;
      }

      await this.prisma.pullRequest.update({
        where: { id: pr.id },
        data: {
          firstReviewAt: sorted[0] ? new Date(sorted[0].submittedAt) : null,
          approvedAt: (() => {
            const approved = sorted.find((r) => r.state === 'approved');
            return approved ? new Date(approved.submittedAt) : null;
          })(),
          reviewsFetchedAt: new Date(),
        },
      });
      updated++;
    }

    const remaining =
      (await this.prisma.pullRequest.count({
        where: { tenantId, reviewsFetchedAt: null },
      })) +
      (
        await this.prisma.prReview.findMany({
          where: { tenantId, commentsCounted: false },
          select: { repoFullName: true, externalNumber: true },
          distinct: ['repoFullName', 'externalNumber'],
        })
      ).length;

    this.logger.log(
      `Reconciled PR reviews: ${updated} PRs updated, ${reviewsWritten} reviews written, ${skipped} skipped, ${remaining} remaining` +
        (rateLimited
          ? reserved
            ? ` (paused at the rate reserve — resumes ${resumeAt?.toISOString()})`
            : ` (rate-limited by GitHub — resumes ${resumeAt?.toISOString()})`
          : ''),
    );
    return {
      candidates: candidates.length,
      updated,
      reviewsWritten,
      skipped,
      rateLimited,
      remaining,
      resumeAt,
    };
  }
}
