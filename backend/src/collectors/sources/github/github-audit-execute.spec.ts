import { readGithubAuditConfig } from './github-audit.config';
import { GithubAuditSyncService } from './github-audit-sync.service';
import {
  fakeIngestion,
  fakePrisma,
  seedTenant,
} from './github-audit-sync.fakes';

const NOW = new Date('2026-10-06T10:00:00Z');
const SHADOW = readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'shadow' });
const INGEST = readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'ingest' });

const commit = (sha: string, login?: string, parentCount = 1) => ({
  sha,
  message: `m ${sha}`,
  authorLogin: login,
  authorName: 'Arun Balaji M',
  authorEmail: 'arun@narayanahealth.org',
  authoredAt: '2026-09-25T09:00:00Z',
  committedAt: '2026-09-25T09:01:00Z',
  parentCount,
});

function setup() {
  const prisma = fakePrisma();
  const ingestion = fakeIngestion(prisma);
  const audit = {
    listGitPushes: jest.fn().mockResolvedValue({
      status: 'complete',
      events: [],
      pages: 1,
      nextTraversals: 0,
    }),
  };
  const client = {
    listHeadRefs: jest.fn(),
    getDefaultBranch: jest.fn().mockResolvedValue({ name: 'master' }),
    compareAll: jest.fn(),
    getCommitDetail: jest.fn().mockResolvedValue({
      additions: 10,
      deletions: 2,
      filesChanged: 3,
      committedAt: '2026-09-25T09:01:00Z',
    }),
  };
  const secrets = {
    resolve: jest.fn(async (_t: string, ref?: string | null) =>
      ref ? `tok:${ref}` : '',
    ),
  };
  const svc = new GithubAuditSyncService(
    prisma as never,
    secrets as never,
    ingestion as never,
    audit as never,
    client as never,
  );
  seedTenant(prisma, 't1', ['athmahealth/ehr']);
  prisma.githubAuditCheckpoint.rows.push({
    id: 'cp',
    tenantId: 't1',
    organization: 'acme',
    seededAt: new Date(NOW.getTime() - 3_600_000),
    checkpointAt: new Date(NOW.getTime() - 300_000),
  });
  prisma.githubRefTip.rows.push({
    id: 'h',
    tenantId: 't1',
    repoFullName: 'athmahealth/ehr',
    ref: 'HEAD',
    sha: 'master',
    seenAt: NOW,
  });
  return { prisma, ingestion, client, svc };
}

function addRange(
  prisma: ReturnType<typeof fakePrisma>,
  over: Record<string, unknown> = {},
) {
  const row = {
    id: `r${prisma.githubPushRange.rows.length + 1}`,
    tenantId: 't1',
    runId: 'old',
    connectionId: 't1-conn-0',
    repoFullName: 'athmahealth/ehr',
    ref: 'ACT-92441-aot-induction',
    baseSha: null,
    baseRef: 'master',
    headSha: '50b124b05b',
    kind: 'new_ref',
    auditDocumentIds: ['d1'],
    status: 'pending',
    attempts: 0,
    commitsFound: 0,
    alreadyPresent: 0,
    ingested: 0,
    truncated: false,
    lastError: null,
    createdAt: new Date(NOW.getTime() - 60_000),
    ...over,
  };
  prisma.githubPushRange.rows.push(row);
  return row;
}

describe('executePending', () => {
  it('25 Sep fixture: recovers branch-only ehr commits with lineage, then ingests nothing on a rerun', async () => {
    const { prisma, ingestion, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [
        commit('0defa5a6e4', 'arun-athma'),
        commit('50b124b05b', 'arun-athma'),
      ],
      status: 'ahead',
      totalCommits: 2,
      pages: 1,
      truncated: false,
    });
    const r = await svc.runTenant('t1', INGEST, NOW);

    expect(client.compareAll).toHaveBeenCalledWith(
      'athmahealth/ehr',
      'tok:GITHUB_TOKEN',
      'master',
      '50b124b05b',
    );
    const commitCalls = ingestion.ingest.mock.calls.filter(
      (c) => c[1].eventType === 'code.commit.pushed',
    );
    expect(commitCalls.map((c) => c[1].idempotencyKey)).toEqual([
      'github:athmahealth/ehr:commit:0defa5a6e4',
      'github:athmahealth/ehr:commit:50b124b05b',
    ]);
    expect(commitCalls[0][1].externalRefs).toMatchObject({
      ref: 'ACT-92441-aot-induction',
      discoveredBy: 'github-audit-compare',
      pushRangeId: 'r1',
    });
    expect(commitCalls[0][1].data).toMatchObject({
      additions: 10,
      deletions: 2,
      filesChanged: 3,
      parentCount: 1,
      authorLogin: 'arun-athma',
    });
    expect(r.counters).toMatchObject({
      ingested: 2,
      alreadyPresent: 0,
      commitsDiscovered: 2,
      compareRequestsExecuted: 1,
    });
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      status: 'done',
      ingested: 2,
    });

    addRange(prisma); // the same range discovered again (overlap / second push)
    const again = await svc.runTenant(
      't1',
      INGEST,
      new Date(NOW.getTime() + 300_000),
    );
    expect(again.counters).toMatchObject({ ingested: 0, alreadyPresent: 2 });
    expect(client.getCommitDetail).toHaveBeenCalledTimes(2);
  });

  it('counts a commit the existing collector already ingested as alreadyPresent, with no detail call', async () => {
    const { prisma, client, svc } = setup();
    prisma.rawKeys.add('t1|github:athmahealth/ehr:commit:aaa');
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('aaa', 'x')],
      pages: 1,
      truncated: false,
    });
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(r.counters).toMatchObject({ alreadyPresent: 1, ingested: 0 });
    expect(client.getCommitDetail).not.toHaveBeenCalled();
  });

  it('shadow mode reports wouldIngest, writes no commit, and ingest mode replays it later', async () => {
    const { prisma, ingestion, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('bbb')],
      pages: 1,
      truncated: false,
    });
    const s = await svc.runTenant('t1', SHADOW, NOW);
    expect(s.counters).toMatchObject({
      wouldIngest: 1,
      ingested: 0,
      commitsWithoutLogin: 1,
    });
    expect(
      ingestion.ingest.mock.calls.some(
        (c) => c[1].eventType === 'code.commit.pushed',
      ),
    ).toBe(false);
    expect(prisma.githubPushRange.rows[0].status).toBe('shadowed');

    const i = await svc.runTenant(
      't1',
      INGEST,
      new Date(NOW.getTime() + 300_000),
    );
    expect(i.counters.ingested).toBe(1);
    expect(prisma.githubPushRange.rows[0].status).toBe('done');
  });

  it('keeps an email-only author unattributed: no login is invented', async () => {
    const { prisma, ingestion, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('ccc', undefined)],
      pages: 1,
      truncated: false,
    });
    const r = await svc.runTenant('t1', INGEST, NOW);
    const env = ingestion.ingest.mock.calls.find(
      (c) => c[1].eventType === 'code.commit.pushed',
    )![1];
    expect(env.data.authorLogin).toBeUndefined();
    expect(env.data.authorEmail).toBe('arun@narayanahealth.org');
    expect(r.counters.commitsWithoutLogin).toBe(1);
  });

  it('dedupes a commit reachable from two ranges in one run', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma);
    addRange(prisma, { ref: 'other', headSha: 'zzz' });
    client.compareAll.mockResolvedValue({
      commits: [commit('same', 'x')],
      pages: 1,
      truncated: false,
    });
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(r.counters).toMatchObject({ ingested: 1, alreadyPresent: 1 });
  });

  it('retries a moved range against the default branch when its base is gone', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma, { kind: 'moved', baseSha: 'gone', baseRef: null });
    client.compareAll
      .mockResolvedValueOnce({
        commits: [],
        pages: 0,
        truncated: false,
        failure: 'not_found',
      })
      .mockResolvedValueOnce({
        commits: [commit('ddd', 'x')],
        pages: 1,
        truncated: false,
        status: 'diverged',
      });
    await svc.runTenant('t1', INGEST, NOW);
    expect(client.compareAll.mock.calls[1]).toEqual([
      'athmahealth/ehr',
      'tok:GITHUB_TOKEN',
      'master',
      '50b124b05b',
    ]);
    expect(prisma.githubPushRange.rows[0].status).toBe('done');
  });

  it('a failed Compare stays pending with attempts+1, and becomes failed at the cap', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma, { attempts: 3 });
    client.compareAll.mockResolvedValue({
      commits: [],
      pages: 0,
      truncated: false,
      failure: 'failed',
    });
    const cfg = readGithubAuditConfig({
      GITHUB_AUDIT_SYNC_MODE: 'ingest',
      GITHUB_AUDIT_MAX_RANGE_ATTEMPTS: '5',
    });
    await svc.runTenant('t1', cfg, NOW);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      status: 'pending',
      attempts: 4,
    });
    const r = await svc.runTenant('t1', cfg, new Date(NOW.getTime() + 300_000));
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      status: 'failed',
      attempts: 5,
    });
    expect(r.counters.failedRanges).toBe(1);
  });

  it('a rate limit stops the run without burning an attempt', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma);
    addRange(prisma, { ref: 'second' });
    client.compareAll.mockResolvedValue({
      commits: [],
      pages: 0,
      truncated: false,
      failure: 'rate_limited',
      resumeAt: NOW,
    });
    const r = await svc.runTenant(
      't1',
      readGithubAuditConfig({
        GITHUB_AUDIT_SYNC_MODE: 'ingest',
        GITHUB_AUDIT_COMPARE_CONCURRENCY: '1',
      }),
      NOW,
    );
    expect(
      prisma.githubPushRange.rows.every(
        (x) => x.status === 'pending' && x.attempts === 0,
      ),
    ).toBe(true);
    expect(client.compareAll).toHaveBeenCalledTimes(1);
    expect(r.counters.pendingRanges).toBe(2);
  });

  it('an ingestion error fails that range only', async () => {
    const { prisma, ingestion, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('eee', 'x')],
      pages: 1,
      truncated: false,
    });
    ingestion.ingest.mockRejectedValueOnce(new Error('db down'));
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
    expect(prisma.githubPushRange.rows[0].lastError).toMatch(/db down/);
    expect(r.status).toBe('success'); // discovery succeeded; the range is queued for retry
  });

  it('marks truncated Compares and still ingests what was returned', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('fff', 'x')],
      pages: 3,
      truncated: true,
      totalCommits: 400,
    });
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      truncated: true,
      status: 'done',
    });
    expect(r.counters).toMatchObject({ truncatedRanges: 1, comparePages: 3 });
  });

  it("executes an aged pending range but ignores an aged shadowed range and other tenants' ranges", async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma, {
      headSha: 'agedpending',
      createdAt: new Date(NOW.getTime() - 8 * 86_400_000),
    });
    addRange(prisma, {
      headSha: 'agedshadowed',
      status: 'shadowed',
      createdAt: new Date(NOW.getTime() - 8 * 86_400_000),
    });
    addRange(prisma, { tenantId: 't2', headSha: 'othertenant' });
    client.compareAll.mockResolvedValue({
      commits: [],
      pages: 0,
      truncated: false,
    });
    await svc.runTenant('t1', INGEST, NOW);
    expect(client.compareAll).toHaveBeenCalledTimes(1);
    expect(client.compareAll).toHaveBeenCalledWith(
      'athmahealth/ehr',
      'tok:GITHUB_TOKEN',
      'master',
      'agedpending',
    );
  });

  it('stops issuing detail calls once the core rate budget estimate is exhausted, leaving the range pending', async () => {
    const { prisma, client, svc } = setup();
    const originalReserve = process.env.GITHUB_BACKFILL_RATE_RESERVE;
    process.env.GITHUB_BACKFILL_RATE_RESERVE = '1000';
    try {
      addRange(prisma);
      client.compareAll.mockResolvedValue({
        commits: [commit('d1', 'x'), commit('d2', 'x'), commit('d3', 'x')],
        pages: 1,
        truncated: false,
        rateLimit: { remaining: 1002, resetAt: NOW },
      });
      const r = await svc.runTenant('t1', INGEST, NOW);
      // budget = (1002 - 1000) - 1 page = 1; the first detail call spends it
      // to 0, so the second and third commits never reach getCommitDetail.
      expect(client.getCommitDetail).toHaveBeenCalledTimes(1);
      expect(prisma.githubPushRange.rows[0].status).toBe('pending');
      expect(r.counters.ingested).toBe(1);
    } finally {
      if (originalReserve === undefined) {
        delete process.env.GITHUB_BACKFILL_RATE_RESERVE;
      } else {
        process.env.GITHUB_BACKFILL_RATE_RESERVE = originalReserve;
      }
    }
  });

  it('does not ingest a commit whose detail call returned no stats, and fails the range for retry', async () => {
    const { prisma, ingestion, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('abc1234567', 'x')],
      pages: 1,
      truncated: false,
    });
    client.getCommitDetail.mockResolvedValue({});
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(
      ingestion.ingest.mock.calls.some(
        (c) => c[1].eventType === 'code.commit.pushed',
      ),
    ).toBe(false);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
    expect(prisma.githubPushRange.rows[0].lastError).toMatch(
      /Commit detail unavailable for abc1234/,
    );
    expect(r.counters.ingested).toBe(0);
  });

  it('keeps the partial ingested count when a later commit in the same range throws', async () => {
    const { prisma, ingestion, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('ok1', 'x'), commit('boom', 'x')],
      pages: 1,
      truncated: false,
    });
    const originalImpl = ingestion.ingest.getMockImplementation();
    ingestion.ingest
      .mockImplementationOnce(async (tenantId, envelope) =>
        originalImpl!(tenantId, envelope),
      )
      .mockRejectedValueOnce(new Error('kaboom'));
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(r.counters.ingested).toBe(1);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
    expect(prisma.githubPushRange.rows[0].lastError).toMatch(/kaboom/);
  });

  it('counts a commit reachable from two ranges only once as wouldIngest in shadow mode', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma);
    addRange(prisma, { ref: 'other', headSha: 'zzz' });
    client.compareAll.mockResolvedValue({
      commits: [commit('dup', 'x')],
      pages: 1,
      truncated: false,
    });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.counters).toMatchObject({ wouldIngest: 1, alreadyPresent: 1 });
  });

  it('does not strand a commit a sibling range can still ingest: claiming happens only after ingest succeeds', async () => {
    const { prisma, ingestion, client, svc } = setup();
    const r1 = addRange(prisma, { ref: 'range-one', headSha: 'h1' });
    const r2 = addRange(prisma, { ref: 'range-two', headSha: 'h2' });
    client.compareAll.mockResolvedValue({
      commits: [commit('stranded', 'x')],
      pages: 1,
      truncated: false,
    });
    // Range 1's detail call for 'stranded' comes back with no stats (not a
    // rate limit), failing range 1's attempt before it ever reaches
    // ingestion.ingest; range 2's call for the same commit gets stats and
    // succeeds.
    client.getCommitDetail.mockResolvedValueOnce({}).mockResolvedValue({
      additions: 10,
      deletions: 2,
      filesChanged: 3,
      committedAt: '2026-09-25T09:01:00Z',
    });
    const cfg = readGithubAuditConfig({
      GITHUB_AUDIT_SYNC_MODE: 'ingest',
      GITHUB_AUDIT_COMPARE_CONCURRENCY: '1',
    });
    const r = await svc.runTenant('t1', cfg, NOW);

    const commitCalls = ingestion.ingest.mock.calls.filter(
      (c) => c[1].eventType === 'code.commit.pushed',
    );
    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0][1].externalRefs).toMatchObject({
      pushRangeId: r2.id,
    });
    expect(
      prisma.githubPushRange.rows.find((x) => x.id === r1.id),
    ).toMatchObject({ status: 'pending', attempts: 1 });
    expect(
      prisma.githubPushRange.rows.find((x) => x.id === r2.id),
    ).toMatchObject({ status: 'done', ingested: 1 });
    expect(r.counters.ingested).toBe(1);
  });
});
