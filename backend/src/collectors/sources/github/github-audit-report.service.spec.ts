import { GithubAuditReportService } from './github-audit-report.service';

describe('GithubAuditReportService.dayReport', () => {
  it('sums run counters for the IST day, counts ranges, and lists audit-ingested commits — tenant-scoped', async () => {
    const calls: unknown[] = [];
    const rec = (result: unknown) =>
      jest.fn(async (args: unknown) => {
        calls.push(args);
        return result;
      });
    const prisma = {
      githubAuditRun: {
        findMany: rec([
          {
            status: 'success',
            counters: {
              auditEvents: 10,
              uniquePushes: 9,
              compareCandidatesNaive: 9,
              compareRequestsPlanned: 3,
              ingested: 2,
            },
          },
          { status: 'failed', counters: { auditEvents: 0 } },
        ]),
      },
      githubPushRange: {
        findMany: rec([
          { status: 'done', truncated: false, repoFullName: 'a/ehr', ref: 'x' },
          {
            status: 'pending',
            truncated: true,
            repoFullName: 'a/ehr',
            ref: 'y',
          },
          {
            status: 'failed',
            truncated: false,
            repoFullName: 'a/amma',
            ref: 'x',
          },
        ]),
      },
      rawEvent: {
        findMany: rec([
          {
            envelope: {
              externalRefs: {
                repo: 'a/ehr',
                sha: '0defa5a6e4',
                ref: 'ACT-92441-aot-induction',
              },
              data: { authorLogin: 'arun', authorEmail: 'a@x' },
            },
          },
        ]),
      },
      githubAuditCheckpoint: {
        findUnique: rec({
          checkpointAt: new Date('2026-10-06T04:00:00Z'),
          seededAt: null,
          lastStatus: 'success',
          lastError: null,
        }),
      },
    };
    const svc = new GithubAuditReportService(prisma as never);
    const r = await svc.dayReport('t1', '2026-10-05');

    expect(r.runs).toBe(2);
    expect(r.failedRuns).toBe(1);
    expect(r.totals).toMatchObject({
      auditEvents: 10,
      compareCandidatesNaive: 9,
      compareRequestsPlanned: 3,
      ingested: 2,
    });
    expect(r.ranges).toEqual({
      pending: 1,
      shadowed: 0,
      done: 1,
      failed: 1,
      truncated: 1,
    });
    expect(r.repositoriesAffected).toBe(2);
    expect(r.branchesAffected).toBe(3);
    expect(r.auditCommits).toEqual([
      {
        repoFullName: 'a/ehr',
        sha: '0defa5a6e4',
        ref: 'ACT-92441-aot-induction',
        authorLogin: 'arun',
        authorEmail: 'a@x',
      },
    ]);
    for (const c of calls)
      expect(JSON.stringify(c)).toContain('"tenantId":"t1"');
    const runWhere = (
      prisma.githubAuditRun.findMany.mock.calls[0][0] as {
        where: { startedAt: { gte: Date; lte: Date } };
      }
    ).where;
    expect(runWhere.startedAt.gte.toISOString()).toBe(
      '2026-10-04T18:30:00.000Z',
    );
  });
});
