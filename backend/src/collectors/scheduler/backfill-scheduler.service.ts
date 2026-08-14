import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../database/prisma.service';
import { GithubCommitMessageReconcilerService } from '../sources/github/github-commit-message-reconciler.service';
import { GithubPrReconcilerService } from '../sources/github/github-pr-reconciler.service';
import { GithubReviewReconcilerService } from '../sources/github/github-review-reconciler.service';
import { JiraStoryDateReconcilerService } from '../sources/jira/jira-story-date-reconciler.service';

/**
 * Drives the one-off data reconcilers to completion on their own (BC-1).
 *
 * Before this, each reconciler was a manual endpoint that did one bounded
 * batch: filling ~2,500 PRs meant calling it by hand a dozen times, and the
 * runs that hit GitHub's hourly limit simply reported `rateLimited` and stopped
 * until somebody noticed. Backfill is exactly the kind of work that should
 * grind away unattended, so this ticks it forward instead.
 *
 * Two properties make an unattended loop safe here, and neither is optional:
 *
 *  1. **Every reconciler terminates.** A row stops being a candidate once it
 *     has been *asked about* — `reviewsFetchedAt`, `detailFetchedAt`,
 *     `sourceCreatedAt` — not once it has been successfully filled. Rows the
 *     source can never satisfy (an empty diff, a merger whose account is gone)
 *     would otherwise be re-fetched every tick forever.
 *  2. **It stops while quota remains.** The reconcilers halt at a reserve
 *     (`GITHUB_BACKFILL_RATE_RESERVE`, default 1000) rather than draining the
 *     token, so the scheduled sync — the thing users are actually waiting on —
 *     keeps working while backfill catches up over hours.
 *
 * Idle cost is one COUNT per tenant per source once everything is filled.
 */
@Injectable()
export class BackfillSchedulerService {
  private readonly logger = new Logger(BackfillSchedulerService.name);

  /**
   * Per-tenant cooldowns, in memory: when a reconciler reported it had run out
   * of quota, there is nothing to gain by asking again before the reset. Held
   * in memory rather than persisted because losing it on restart only costs
   * one wasted probe, and the reconciler stops immediately anyway.
   */
  private readonly cooldowns = new Map<string, Date>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly reviews: GithubReviewReconcilerService,
    private readonly prStats: GithubPrReconcilerService,
    private readonly commitMessages: GithubCommitMessageReconcilerService,
    private readonly storyDates: JiraStoryDateReconcilerService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async tick(): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });

    for (const tenant of tenants) {
      const until = this.cooldowns.get(tenant.id);
      if (until && until.getTime() > Date.now()) {
        continue;
      }
      try {
        await this.runTenant(tenant.id);
      } catch (error) {
        // One tenant's failure must not stop the sweep for the rest.
        this.logger.error(
          `Backfill sweep failed for tenant ${tenant.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * One batch per source per tick. Deliberately not a loop-until-done: a tick
   * that ran to completion would hold the quota for as long as it took and
   * make the reserve pointless. Progress is measured in ticks, not in one
   * heroic pass.
   */
  private async runTenant(tenantId: string): Promise<void> {
    const jira = await this.storyDates.reconcile(tenantId);
    if (jira.updated > 0) {
      this.logger.log(
        `Backfill (tenant ${tenantId}): ${jira.updated} Jira story dates filled.`,
      );
    }

    const reviews = await this.reviews.reconcile(tenantId);
    if (reviews.updated > 0 || reviews.remaining > 0) {
      this.logger.log(
        `Backfill (tenant ${tenantId}): reviews — ${reviews.updated} PRs, ${reviews.remaining} remaining.`,
      );
    }
    if (reviews.resumeAt) {
      this.cooldowns.set(tenantId, reviews.resumeAt);
      return; // no quota left for the next reconciler either
    }

    const stats = await this.prStats.reconcile(tenantId);
    if (stats.updated > 0 || stats.remaining > 0) {
      this.logger.log(
        `Backfill (tenant ${tenantId}): PR detail — ${stats.updated} PRs, ${stats.remaining} remaining.`,
      );
    }
    if (stats.resumeAt) {
      this.cooldowns.set(tenantId, stats.resumeAt);
      return;
    }

    const messages = await this.commitMessages.reconcile(tenantId);
    if (messages.updated > 0 || messages.remaining > 0) {
      this.logger.log(
        `Backfill (tenant ${tenantId}): commit messages — ${messages.updated} PRs, ${messages.remaining} remaining.`,
      );
    }
    if (messages.resumeAt) {
      this.cooldowns.set(tenantId, messages.resumeAt);
    }
  }
}
