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
