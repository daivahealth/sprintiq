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
