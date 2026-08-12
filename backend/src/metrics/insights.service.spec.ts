import { CorrelationService } from '../correlation/correlation.service';
import { CodeService } from '../modules/code/code.service';
import { PlanningService } from '../modules/planning/planning.service';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { InsightsService } from './insights.service';

function commit(overrides: Record<string, unknown> = {}) {
  return {
    sha: 'abc1234567',
    repoFullName: 'acme/payments',
    message: 'msg',
    authorLogin: 'jdoe',
    additions: 3,
    deletions: 1,
    filesChanged: 2,
    authoredAt: new Date('2026-06-01T00:00:00.000Z'),
    committedAt: new Date('2026-06-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('InsightsService committer-date windowing', () => {
  let code: jest.Mocked<CodeService>;
  let planning: jest.Mocked<PlanningService>;
  let correlation: jest.Mocked<CorrelationService>;
  let tenantContext: jest.Mocked<TenantContextService>;
  let service: InsightsService;

  beforeEach(() => {
    code = {
      listCommits: jest.fn(),
      listPullRequestsByAuthor: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<CodeService>;
    planning = {
      listProjectKeys: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<PlanningService>;
    correlation = {
      reposLinkedToProjects: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<CorrelationService>;
    tenantContext = {
      requireTenantId: jest.fn().mockReturnValue('tenant-a'),
    } as unknown as jest.Mocked<TenantContextService>;
    service = new InsightsService(tenantContext, planning, code, correlation);
  });

  it('developerActivity groups dailySeries/lastCommitAt by committedAt, and exposes both dates on recentCommits', async () => {
    code.listCommits.mockResolvedValue([commit()] as never);

    const view = await service.developerActivity(
      'jdoe',
      new Date('2026-06-01T00:00:00.000Z'),
    );

    // authoredAt is 06-01, committedAt is 06-02 — the bucket must follow committedAt
    expect(view.dailySeries).toEqual([
      { date: '2026-06-02', commits: 1, locChanged: 4 },
    ]);
    expect(view.byRepo[0].lastCommitAt).toBe('2026-06-02T00:00:00.000Z');
    expect(view.recentCommits[0]).toMatchObject({
      authoredAt: '2026-06-01T00:00:00.000Z',
      committedAt: '2026-06-02T00:00:00.000Z',
    });
  });

  it('developerActivity falls back to authoredAt when committedAt is null', async () => {
    code.listCommits.mockResolvedValue([
      commit({ committedAt: null }),
    ] as never);

    const view = await service.developerActivity(
      'jdoe',
      new Date('2026-06-01T00:00:00.000Z'),
    );

    expect(view.dailySeries).toEqual([
      { date: '2026-06-01', commits: 1, locChanged: 4 },
    ]);
    expect(view.recentCommits[0].committedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('projectActivity groups dailySeries by committedAt', async () => {
    code.listCommits.mockResolvedValue([commit()] as never);

    const rows = await service.projectActivity(
      new Date('2026-06-01T00:00:00.000Z'),
    );

    expect(rows[0].dailySeries).toEqual([
      { date: '2026-06-02', commits: 1, locChanged: 4 },
    ]);
  });
});

describe('InsightsService.flowMetrics', () => {
  const NOW = new Date('2026-06-30T00:00:00.000Z');
  let planning: jest.Mocked<PlanningService>;
  let service: InsightsService;

  function item(externalKey: string, status = 'In Progress') {
    return { externalKey, projectKey: 'PAY', status, type: 'story' };
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    planning = {
      listFlowItems: jest.fn().mockResolvedValue([]),
      flowTimestamps: jest.fn().mockResolvedValue(new Map()),
    } as unknown as jest.Mocked<PlanningService>;
    const tenantContext = {
      requireTenantId: jest.fn().mockReturnValue('tenant-a'),
    } as unknown as jest.Mocked<TenantContextService>;
    service = new InsightsService(
      tenantContext,
      planning,
      {} as unknown as CodeService,
      {} as unknown as CorrelationService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('excludes click-through completions from the percentiles and reports them separately', async () => {
    planning.listFlowItems.mockResolvedValue([
      item('PAY-1'),
      item('PAY-2'),
      item('PAY-3'),
    ] as never);
    planning.flowTimestamps.mockResolvedValue(
      new Map([
        // real: 10 days of work
        [
          'PAY-1',
          {
            firstInProgressAt: new Date('2026-06-01T00:00:00.000Z'),
            firstDoneAt: new Date('2026-06-11T00:00:00.000Z'),
          },
        ],
        // click-through: in-progress and done 2 seconds apart
        [
          'PAY-2',
          {
            firstInProgressAt: new Date('2026-06-01T00:00:00.000Z'),
            firstDoneAt: new Date('2026-06-01T00:00:02.000Z'),
          },
        ],
        // done recorded BEFORE work started — noise, grouped with instants
        [
          'PAY-3',
          {
            firstInProgressAt: new Date('2026-06-05T00:00:00.000Z'),
            firstDoneAt: new Date('2026-06-01T00:00:00.000Z'),
          },
        ],
      ]) as never,
    );

    const view = await service.flowMetrics([]);

    expect(view.cycleTime.sampleSize).toBe(1);
    expect(view.cycleTime.p50Days).toBe(10);
    expect(view.cycleTime.excludedInstant).toBe(2);
  });

  it('counts only started-but-not-done items as WIP, and ages them from when work started', async () => {
    planning.listFlowItems.mockResolvedValue([
      item('PAY-1'),
      item('PAY-2'),
    ] as never);
    planning.flowTimestamps.mockResolvedValue(
      new Map([
        // started 10 days ago, still open
        [
          'PAY-1',
          {
            firstInProgressAt: new Date('2026-06-20T00:00:00.000Z'),
            currentStatusEnteredAt: new Date('2026-06-20T00:00:00.000Z'),
          },
        ],
        // already done — not WIP
        [
          'PAY-2',
          {
            firstInProgressAt: new Date('2026-06-01T00:00:00.000Z'),
            firstDoneAt: new Date('2026-06-11T00:00:00.000Z'),
          },
        ],
      ]) as never,
    );

    const view = await service.flowMetrics([]);

    expect(view.wip.count).toBe(1);
    expect(view.wip.oldestDays).toBe(10);
  });

  it('flags items sitting past the ageing threshold, and reports coverage rather than counting history-less items as zero', async () => {
    planning.listFlowItems.mockResolvedValue([
      item('PAY-1', 'Blocked in QA'),
      item('PAY-2'),
      item('PAY-3'), // no transition history at all
    ] as never);
    planning.flowTimestamps.mockResolvedValue(
      new Map([
        [
          'PAY-1',
          {
            firstInProgressAt: new Date('2026-06-01T00:00:00.000Z'),
            currentStatusEnteredAt: new Date('2026-06-10T00:00:00.000Z'),
          },
        ],
        [
          'PAY-2',
          {
            firstInProgressAt: new Date('2026-06-29T00:00:00.000Z'),
            currentStatusEnteredAt: new Date('2026-06-29T00:00:00.000Z'),
          },
        ],
      ]) as never,
    );

    const view = await service.flowMetrics([], 7);

    // PAY-1 has been in status 20 days; PAY-2 only 1 day
    expect(view.aging.count).toBe(1);
    expect(view.aging.items[0]).toMatchObject({
      externalKey: 'PAY-1',
      status: 'Blocked in QA',
    });
    // PAY-3 is in scope but unmeasurable — surfaced, not silently averaged in
    expect(view.coverage).toEqual({
      itemsInScope: 3,
      itemsWithHistory: 2,
      coveragePct: 66.7,
    });
  });
});

describe('InsightsService aggregate scope', () => {
  let planning: jest.Mocked<PlanningService>;
  let code: jest.Mocked<CodeService>;
  let correlation: jest.Mocked<CorrelationService>;
  let service: InsightsService;

  beforeEach(() => {
    planning = {
      listWorkItems: jest.fn().mockResolvedValue([]),
      listAllWorkItems: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<PlanningService>;
    code = {
      listDashboardPullRequests: jest.fn().mockResolvedValue([]),
      listReviewsForPullRequests: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<CodeService>;
    correlation = {
      prRefsByStoryId: jest.fn().mockResolvedValue(new Map()),
    } as unknown as jest.Mocked<CorrelationService>;
    const tenantContext = {
      requireTenantId: jest.fn().mockReturnValue('tenant-a'),
    } as unknown as jest.Mocked<TenantContextService>;
    service = new InsightsService(tenantContext, planning, code, correlation);
  });

  // listWorkItems caps at 500 for table display. Using it for an aggregate
  // computed a denominator over an arbitrary slice while presenting it as the
  // whole scope — on a real tenant, 500 where 12,675 existed.
  it('efficiency derives its denominators from the uncapped query', async () => {
    await service.efficiency([], [], new Date('2026-06-01T00:00:00.000Z'));

    expect(planning.listAllWorkItems).toHaveBeenCalled();
    expect(planning.listWorkItems).not.toHaveBeenCalled();
  });

  it('productivity sums throughput from the uncapped query', async () => {
    await service.productivity([], [], new Date('2026-06-01T00:00:00.000Z'));

    expect(planning.listAllWorkItems).toHaveBeenCalled();
    expect(planning.listWorkItems).not.toHaveBeenCalled();
  });

  // lead_time must come from Jira's creation date. Measuring it from the row's
  // own `createdAt` — the date the backfill inserted it — made every
  // pre-existing item look days old instead of months, and the negative results
  // were dropped by a `>= 0` filter rather than surfacing the problem.
  it('measures story lead time from the Jira creation date, not the ingestion date', async () => {
    const ingestedAt = new Date('2026-06-10T00:00:00.000Z');
    planning.listAllWorkItems.mockResolvedValue([
      {
        id: 's1',
        type: 'story',
        sourceCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
        resolvedAt: new Date('2026-01-11T00:00:00.000Z'),
        createdAt: ingestedAt,
      },
      {
        id: 's2',
        type: 'story',
        sourceCreatedAt: new Date('2026-02-01T00:00:00.000Z'),
        resolvedAt: new Date('2026-02-21T00:00:00.000Z'),
        createdAt: ingestedAt,
      },
    ] as never);

    const view = await service.efficiency(
      [],
      [],
      new Date('2026-06-01T00:00:00.000Z'),
    );

    expect(view.storyCycle.sampleSize).toBe(2);
    expect(view.storyCycle.p50Days).toBe(10);
    expect(view.storyCycle.excludedNoCreatedAt).toBe(0);
  });

  it('excludes and discloses resolved items with no Jira creation date', async () => {
    planning.listAllWorkItems.mockResolvedValue([
      {
        id: 's1',
        type: 'story',
        sourceCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
        resolvedAt: new Date('2026-01-11T00:00:00.000Z'),
        createdAt: new Date('2026-06-10T00:00:00.000Z'),
      },
      // Collected before `created` was requested and unchanged since, so the
      // sync hasn't re-walked it. Counted, never estimated from `createdAt`.
      {
        id: 's2',
        type: 'story',
        sourceCreatedAt: null,
        resolvedAt: new Date('2026-02-21T00:00:00.000Z'),
        createdAt: new Date('2026-06-10T00:00:00.000Z'),
      },
    ] as never);

    const view = await service.efficiency(
      [],
      [],
      new Date('2026-06-01T00:00:00.000Z'),
    );

    expect(view.storyCycle.sampleSize).toBe(1);
    expect(view.storyCycle.p50Days).toBe(10);
    expect(view.storyCycle.excludedNoCreatedAt).toBe(1);
    // The traceability denominator still covers every item in scope.
    expect(view.traceability.storiesTotal).toBe(2);
  });
});

/**
 * Review Quality (METRICS.md §3) + pr_cycle_time sub-phases, from the
 * collected `pr_review` timeline.
 */
describe('InsightsService review metrics', () => {
  let planning: jest.Mocked<PlanningService>;
  let code: jest.Mocked<CodeService>;
  let correlation: jest.Mocked<CorrelationService>;
  let service: InsightsService;

  /** Defaults to a PR whose reviews HAVE been fetched (the normal case). */
  function pr(over: Record<string, unknown> = {}) {
    return {
      repoFullName: 'acme/api',
      externalNumber: '1',
      authorLogin: 'jdoe',
      openedAt: new Date('2026-06-01T00:00:00.000Z'),
      mergedAt: new Date('2026-06-03T00:00:00.000Z'),
      firstReviewAt: null,
      approvedAt: null,
      mergedBy: null,
      reviewsFetchedAt: new Date('2026-06-04T00:00:00.000Z'),
      ...over,
    };
  }

  function review(over: Record<string, unknown> = {}) {
    return {
      repoFullName: 'acme/api',
      externalNumber: '1',
      reviewerLogin: 'asmith',
      state: 'approved',
      submittedAt: new Date('2026-06-02T00:00:00.000Z'),
      ...over,
    };
  }

  beforeEach(() => {
    planning = {
      listAllWorkItems: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<PlanningService>;
    code = {
      listDashboardPullRequests: jest.fn().mockResolvedValue([]),
      listReviewsForPullRequests: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<CodeService>;
    correlation = {
      prRefsByStoryId: jest.fn().mockResolvedValue(new Map()),
    } as unknown as jest.Mocked<CorrelationService>;
    const tenantContext = {
      requireTenantId: jest.fn().mockReturnValue('tenant-a'),
    } as unknown as jest.Mocked<TenantContextService>;
    service = new InsightsService(tenantContext, planning, code, correlation);
  });

  const run = () =>
    service.efficiency([], [], new Date('2026-05-01T00:00:00.000Z'));

  it('computes the pr_cycle_time sub-phases from the review timeline', async () => {
    // The phases derive from the REVIEW ROWS, not from the PR's stored
    // firstReviewAt/approvedAt — those are collector-derived over all reviews
    // including bots, so using them would measure the bot.
    code.listDashboardPullRequests.mockResolvedValue([
      pr({ mergedBy: 'asmith' }),
    ] as never);
    code.listReviewsForPullRequests.mockResolvedValue([
      review({
        state: 'commented',
        submittedAt: new Date('2026-06-01T06:00:00.000Z'),
      }),
      review({
        state: 'approved',
        submittedAt: new Date('2026-06-02T00:00:00.000Z'),
      }),
    ] as never);

    const v = await run();

    expect(v.review.timeToFirstReview.p50Hours).toBe(6);
    expect(v.review.reviewTime.p50Hours).toBe(18);
    expect(v.review.mergeTime.p50Hours).toBe(24);
    expect(v.review.mergedWithReviewPct).toBe(100);
  });

  it('excludes PRs whose reviews were never collected instead of calling them unreviewed', async () => {
    code.listDashboardPullRequests.mockResolvedValue([
      // Collected: reviewed.
      pr({
        externalNumber: '1',
        firstReviewAt: new Date('2026-06-01T06:00:00.000Z'),
        mergedBy: 'asmith',
      }),
      // Never enriched — the reviews were never fetched at all.
      pr({ externalNumber: '2', reviewsFetchedAt: null }),
    ] as never);
    code.listReviewsForPullRequests.mockResolvedValue([review()] as never);

    const v = await run();

    // Counting #2 as unreviewed would report 50% coverage from what is
    // really incomplete collection.
    expect(v.review.excludedNoReviewData).toBe(1);
    expect(v.review.mergedWithReviewPct).toBe(100);
    expect(v.review.mergedTotal).toBe(2);
  });

  it('counts a self-merge only when nobody else approved', async () => {
    code.listDashboardPullRequests.mockResolvedValue([
      // Author merged their own PR, but a teammate approved it — normal.
      pr({
        externalNumber: '1',
        mergedBy: 'jdoe',
        firstReviewAt: new Date('2026-06-02T00:00:00.000Z'),
      }),
      // Author merged their own PR with no approval from anyone else.
      pr({ externalNumber: '2', mergedBy: 'jdoe' }),
    ] as never);
    code.listReviewsForPullRequests.mockResolvedValue([
      review({ externalNumber: '1', reviewerLogin: 'asmith' }),
    ] as never);

    const v = await run();

    expect(v.review.selfMergedCount).toBe(1);
    expect(v.review.selfMergedPct).toBe(50);
  });

  it('excludes self-reviews from reviewer load', async () => {
    code.listDashboardPullRequests.mockResolvedValue([
      pr({
        externalNumber: '1',
        mergedBy: 'asmith',
        firstReviewAt: new Date('2026-06-02T00:00:00.000Z'),
      }),
    ] as never);
    code.listReviewsForPullRequests.mockResolvedValue([
      review({ reviewerLogin: 'asmith' }),
      // The author reviewing their own PR is not review load.
      review({ reviewerLogin: 'jdoe', state: 'commented' }),
    ] as never);

    const v = await run();

    expect(v.review.reviewerCount).toBe(1);
    expect(v.review.topReviewerSharePct).toBe(100);
  });
});

/**
 * Bot exclusion (METRICS.md §0) and the depth metrics. On a real tenant an AI
 * review bot was the 2nd-busiest reviewer at 15% of all reviews, answering in
 * seconds — left in, it flatters review coverage AND drags review latency
 * toward zero while no human has looked at the change.
 */
describe('InsightsService review metrics — bots and depth', () => {
  let planning: jest.Mocked<PlanningService>;
  let code: jest.Mocked<CodeService>;
  let correlation: jest.Mocked<CorrelationService>;
  let service: InsightsService;

  function pr(over: Record<string, unknown> = {}) {
    return {
      repoFullName: 'acme/api',
      externalNumber: '1',
      authorLogin: 'jdoe',
      additions: 500,
      deletions: 0,
      openedAt: new Date('2026-06-01T00:00:00.000Z'),
      mergedAt: new Date('2026-06-03T00:00:00.000Z'),
      firstReviewAt: null,
      approvedAt: null,
      mergedBy: null,
      reviewsFetchedAt: new Date('2026-06-04T00:00:00.000Z'),
      ...over,
    };
  }

  function review(over: Record<string, unknown> = {}) {
    return {
      repoFullName: 'acme/api',
      externalNumber: '1',
      reviewerLogin: 'asmith',
      isBot: false,
      state: 'approved',
      commentCount: 0,
      commentsCounted: true,
      submittedAt: new Date('2026-06-02T00:00:00.000Z'),
      ...over,
    };
  }

  beforeEach(() => {
    planning = {
      listAllWorkItems: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<PlanningService>;
    code = {
      listDashboardPullRequests: jest.fn().mockResolvedValue([]),
      listReviewsForPullRequests: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<CodeService>;
    correlation = {
      prRefsByStoryId: jest.fn().mockResolvedValue(new Map()),
    } as unknown as jest.Mocked<CorrelationService>;
    const tenantContext = {
      requireTenantId: jest.fn().mockReturnValue('tenant-a'),
    } as unknown as jest.Mocked<TenantContextService>;
    service = new InsightsService(tenantContext, planning, code, correlation);
  });

  const run = () =>
    service.efficiency([], [], new Date('2026-05-01T00:00:00.000Z'));

  it('excludes bot reviews from coverage, latency and reviewer load', async () => {
    code.listDashboardPullRequests.mockResolvedValue([pr()] as never);
    code.listReviewsForPullRequests.mockResolvedValue([
      // Bot answered 6 minutes after opening.
      review({
        reviewerLogin: 'copilot-pull-request-reviewer[bot]',
        isBot: true,
        submittedAt: new Date('2026-06-01T00:06:00.000Z'),
      }),
      // The human took a full day.
      review({
        reviewerLogin: 'asmith',
        submittedAt: new Date('2026-06-02T00:00:00.000Z'),
      }),
    ] as never);

    const v = await run();

    expect(v.review.botReviews).toBe(1);
    expect(v.review.reviewerCount).toBe(1);
    // 24h (the human), not 0.1h (the bot).
    expect(v.review.timeToFirstReview.p50Hours).toBe(24);
  });

  it('counts a bot-only reviewed PR as unreviewed, and reports it', async () => {
    code.listDashboardPullRequests.mockResolvedValue([pr()] as never);
    code.listReviewsForPullRequests.mockResolvedValue([
      review({ reviewerLogin: 'some-bot[bot]', isBot: true }),
    ] as never);

    const v = await run();

    // Reviewed on paper, not in practice.
    expect(v.review.mergedWithReviewPct).toBe(0);
    expect(v.review.botOnlyReviewedPrs).toBe(1);
  });

  it('computes review depth from counted inline comments only', async () => {
    code.listDashboardPullRequests.mockResolvedValue([pr()] as never);
    code.listReviewsForPullRequests.mockResolvedValue([
      review({ externalNumber: '1', commentCount: 3, commentsCounted: true }),
    ] as never);

    const v = await run();

    expect(v.review.reviewDepth.sampleSize).toBe(1);
    expect(v.review.reviewDepth.p50Comments).toBe(3);
  });

  it('flags a large PR approved with zero inline comments as a rubber stamp', async () => {
    code.listDashboardPullRequests.mockResolvedValue([pr()] as never);
    code.listReviewsForPullRequests.mockResolvedValue([
      review({ state: 'approved', commentCount: 0, commentsCounted: true }),
    ] as never);

    const v = await run();

    expect(v.review.rubberStamp.sampleSize).toBe(1);
    expect(v.review.rubberStamp.count).toBe(1);
    expect(v.review.rubberStamp.pct).toBe(100);
  });

  it('never accuses a PR whose comments were not counted', async () => {
    code.listDashboardPullRequests.mockResolvedValue([pr()] as never);
    code.listReviewsForPullRequests.mockResolvedValue([
      review({ state: 'approved', commentCount: 0, commentsCounted: false }),
    ] as never);

    const v = await run();

    // An uncounted zero is not evidence of anything.
    expect(v.review.rubberStamp.sampleSize).toBe(0);
    expect(v.review.rubberStamp.count).toBe(0);
    expect(v.review.reviewDepth.sampleSize).toBe(0);
  });

  it('does not ask the rubber-stamp question of small PRs', async () => {
    code.listDashboardPullRequests.mockResolvedValue([
      pr({ additions: 5, deletions: 2 }),
    ] as never);
    code.listReviewsForPullRequests.mockResolvedValue([
      review({ state: 'approved', commentCount: 0, commentsCounted: true }),
    ] as never);

    const v = await run();

    // A one-line fix approved without comment is not a rubber stamp.
    expect(v.review.rubberStamp.sampleSize).toBe(0);
  });
});
