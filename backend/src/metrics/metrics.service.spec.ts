import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { CorrelationService } from '../correlation/correlation.service';
import { PrismaService } from '../database/prisma.service';
import { CodeService } from '../modules/code/code.service';
import { PlanningService } from '../modules/planning/planning.service';
import { MetricsService } from './metrics.service';

/** Batch PR cycle time: grouped percentiles, empty rows preserved, tenant-scoped. */
describe('MetricsService.computePrCycleTimeForRepos', () => {
  const tenantContext = new TenantContextService();

  function pr(repo: string, openedIso: string, mergedIso: string) {
    return {
      repoFullName: repo,
      externalNumber: String(Math.floor(Math.random() * 1000)),
      openedAt: new Date(openedIso),
      mergedAt: new Date(mergedIso),
      additions: 10,
      deletions: 2,
    };
  }

  const code = {
    listPullRequestsForRepos: jest.fn(),
    listPullRequestsByRefs: jest.fn(),
  } as unknown as CodeService;
  const correlation = {
    bugStoryIdsByRepo: jest.fn(),
    pullRequestRefsByProject: jest.fn(),
  } as unknown as CorrelationService;
  const planning = {
    listBugStoryIdsByProject: jest.fn(),
  } as unknown as PlanningService;

  const svc = new MetricsService(
    {} as PrismaService, // batch path never writes
    tenantContext,
    code,
    correlation,
    planning,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    (code.listPullRequestsForRepos as jest.Mock).mockResolvedValue([
      pr('acme/a', '2026-06-01T00:00:00Z', '2026-06-01T10:00:00Z'), // 10h
      pr('acme/a', '2026-06-02T00:00:00Z', '2026-06-02T20:00:00Z'), // 20h
      pr('acme/b', '2026-06-03T00:00:00Z', '2026-06-03T04:00:00Z'), // 4h
    ]);
    (correlation.bugStoryIdsByRepo as jest.Mock).mockResolvedValue(
      new Map([
        ['acme/a', new Set(['BUG-1', 'BUG-2'])],
        ['acme/b', new Set()],
      ]),
    );
  });

  it('groups by repo, computes p50/p85, and keeps empty repos as rows', async () => {
    const rows = await tenantContext.runWithTenant('tenant-a', () =>
      svc.computePrCycleTimeForRepos(['acme/a', 'acme/b', 'acme/empty']),
    );

    expect(rows.map((r) => r.key)).toEqual(['acme/a', 'acme/b', 'acme/empty']);
    expect(rows[0].metrics.pr_cycle_time).toEqual({
      sampleSize: 2,
      p50Hours: 10,
      p85Hours: 20,
    });
    expect(rows[1].metrics.pr_cycle_time.sampleSize).toBe(1);
    expect(rows[2].metrics.pr_cycle_time).toEqual({
      sampleSize: 0,
      p50Hours: null,
      p85Hours: null,
    });

    // Tenant came from context, passed to the owning-context read.
    expect((code.listPullRequestsForRepos as jest.Mock).mock.calls[0][0]).toBe(
      'tenant-a',
    );
  });

  it('computes change volume and bug context by repo', async () => {
    const rows = await tenantContext.runWithTenant('tenant-a', () =>
      svc.computeMetricsForRepos(
        ['loc_added_deleted', 'bug_count'],
        ['acme/a', 'acme/b'],
      ),
    );

    expect(rows[0].metrics.loc_added_deleted).toMatchObject({
      sampleSize: 2,
      value: 24,
      additions: 20,
      deletions: 4,
      netChanged: 16,
    });
    expect(rows[0].metrics.bug_count).toMatchObject({
      sampleSize: 2,
      value: 2,
    });
  });

  it('refuses to run without tenant context', async () => {
    await expect(svc.computePrCycleTimeForRepos(['acme/a'])).rejects.toThrow();
  });
});
