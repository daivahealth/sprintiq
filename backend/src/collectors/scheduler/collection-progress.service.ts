import { Injectable } from '@nestjs/common';
import { GithubCommitMessageReconcilerService } from '../sources/github/github-commit-message-reconciler.service';
import { GithubPrReconcilerService } from '../sources/github/github-pr-reconciler.service';
import { GithubReviewReconcilerService } from '../sources/github/github-review-reconciler.service';
import { JiraStoryDateReconcilerService } from '../sources/jira/jira-story-date-reconciler.service';

/** How often `BackfillSchedulerService` advances the reconcilers. */
const BACKFILL_TICK_MINUTES = 10;

export interface ReconcilerBacklog {
  key: 'reviews' | 'pr-detail' | 'commit-messages' | 'story-dates';
  label: string;
  /** Rows still waiting to be asked about. */
  remaining: number;
  /** How many this reconciler clears per backfill tick, at best. */
  perTick: number;
  /** Best-case ticks to drain this queue. */
  ticksRemaining: number;
}

export interface CollectionProgress {
  reconcilers: ReconcilerBacklog[];
  /** Nothing outstanding anywhere. */
  caughtUp: boolean;
  /**
   * Best-case minutes until the LAST queue drains, or null when caught up.
   * Never 0 — "0 minutes remaining" reads as "about to finish", which is a
   * different claim from "there is no backlog".
   */
  estimatedMinutesRemaining: number | null;
  /**
   * Always true, and stated rather than implied: the reconcilers stop at a
   * quota reserve (api/README.md §3.2) and a rate-limited tenant sits in a
   * cooldown doing nothing, so the batch ceilings this is derived from are a
   * floor on the time, not a prediction of it.
   */
  estimateIsBestCase: true;
}

/**
 * "Will this tenant be caught up, and roughly when?" — the question Sync
 * Status could not answer.
 *
 * It could say what had *happened* (runs, event counts, badges) but nothing
 * anywhere said whether collection was converging, so an admin had to infer it
 * from log lines. That matters most in exactly the situation this whole
 * area exists for: deciding before the end of the day whether the day's data
 * will actually be in.
 *
 * Lives in the collector context (BC-1) beside the reconcilers it measures,
 * and is exposed through the admin configuration surface rather than through
 * `ConnectionsService` — BC-0 must not depend on BC-1, which already depends
 * on it.
 */
@Injectable()
export class CollectionProgressService {
  constructor(
    private readonly reviews: GithubReviewReconcilerService,
    private readonly prStats: GithubPrReconcilerService,
    private readonly commitMessages: GithubCommitMessageReconcilerService,
    private readonly storyDates: JiraStoryDateReconcilerService,
  ) {}

  async getBacklog(tenantId: string): Promise<CollectionProgress> {
    const [reviews, prDetail, commitMessages, storyDates] = await Promise.all([
      this.reviews.countRemaining(tenantId),
      this.prStats.countRemaining(tenantId),
      this.commitMessages.countRemaining(tenantId),
      this.storyDates.countRemaining(tenantId),
    ]);

    // `perTick` mirrors each reconciler's own default batch limit. Kept beside
    // the counts so the projection below is inspectable rather than a bare
    // number an admin has to trust.
    const reconcilers: ReconcilerBacklog[] = [
      backlog('reviews', 'PR reviews', reviews, 500),
      backlog('pr-detail', 'PR detail (stats, merged-by)', prDetail, 200),
      backlog('commit-messages', 'PR commit messages', commitMessages, 500),
      backlog('story-dates', 'Jira story created dates', storyDates, 20_000),
    ];

    // The SLOWEST queue, not the total: they advance together within one tick,
    // each under its own ceiling, so the tenant is caught up when the last one
    // finishes. Summing and dividing by a combined rate would report a time
    // that arrives while the biggest queue is still draining.
    const ticks = Math.max(...reconcilers.map((r) => r.ticksRemaining));

    return {
      reconcilers,
      caughtUp: ticks === 0,
      estimatedMinutesRemaining:
        ticks === 0 ? null : ticks * BACKFILL_TICK_MINUTES,
      estimateIsBestCase: true,
    };
  }
}

function backlog(
  key: ReconcilerBacklog['key'],
  label: string,
  remaining: number,
  perTick: number,
): ReconcilerBacklog {
  return {
    key,
    label,
    remaining,
    perTick,
    ticksRemaining: Math.ceil(remaining / perTick),
  };
}
