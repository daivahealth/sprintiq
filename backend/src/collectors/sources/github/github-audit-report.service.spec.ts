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

describe('GithubAuditReportService.dayReport rangeDetails', () => {
  it("lists each of the day's ranges with its per-SHA outcomes", async () => {
    const prisma = {
      githubAuditRun: { findMany: jest.fn().mockResolvedValue([]) },
      githubPushRange: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'r1',
            tenantId: 't1',
            repoFullName: 'a/ehr',
            ref: 'ACT-92441-aot-induction',
            kind: 'new_ref',
            baseSha: null,
            baseRef: 'master',
            headSha: '50b124b05b',
            status: 'shadowed',
            truncated: false,
            commitOutcomes: [
              { sha: '0defa5a6e4', outcome: 'wouldIngest' },
              { sha: '50b124b05b', outcome: 'alreadyPresent' },
            ],
          },
          {
            id: 'r2',
            tenantId: 't1',
            repoFullName: 'a/amma',
            ref: 'old',
            kind: 'deleted',
            baseSha: 'x1',
            baseRef: null,
            headSha: null,
            status: 'done',
            truncated: false,
            commitOutcomes: null,
          },
        ]),
      },
      rawEvent: { findMany: jest.fn().mockResolvedValue([]) },
      githubAuditCheckpoint: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const svc = new GithubAuditReportService(prisma as never);
    const r = await svc.dayReport('t1', '2026-10-05');
    expect(r.rangeDetails).toEqual([
      {
        repoFullName: 'a/ehr',
        ref: 'ACT-92441-aot-induction',
        kind: 'new_ref',
        baseSha: null,
        baseRef: 'master',
        headSha: '50b124b05b',
        status: 'shadowed',
        truncated: false,
        commitOutcomes: [
          { sha: '0defa5a6e4', outcome: 'wouldIngest' },
          { sha: '50b124b05b', outcome: 'alreadyPresent' },
        ],
      },
      {
        repoFullName: 'a/amma',
        ref: 'old',
        kind: 'deleted',
        baseSha: 'x1',
        baseRef: null,
        headSha: null,
        status: 'done',
        truncated: false,
        commitOutcomes: [],
      },
    ]);
  });
});
