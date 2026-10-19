import { readGithubAuditConfig } from './github-audit.config';
import { GithubAuditSyncService } from './github-audit-sync.service';
import { commitBranchIdempotencyKey } from './github-commit-envelope';
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
    listBranchCommits: jest.fn(),
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
    // Every audit window here is empty, so auto-registration never runs.
    { findByTenantSourceAndName: jest.fn(), create: jest.fn() } as never,
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
    kind: 'moved',
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

describe('branch tracking (2026-10-19)', () => {
  const marker = (prisma: ReturnType<typeof fakePrisma>) =>
    prisma.githubRefTip.rows.find((r) => r.ref === 'HEAD') as { sha: string };

  it('reads a new branch from its own history and never Compares it with its base', async () => {
    const { prisma, client, svc } = setup();
    const range = addRange(prisma, { kind: 'new_ref', baseRef: 'master' });
    client.listBranchCommits.mockResolvedValue({
      commits: [commit('n1', 'x')],
      pages: 1,
      truncated: false,
    });
    // The only Compare is the link check against the default branch's tip.
    client.compareAll.mockResolvedValue({
      commits: [commit('n1', 'x')],
      pages: 1,
      truncated: false,
    });
    await svc.runTenant('t1', INGEST, NOW);
    expect(client.listBranchCommits).toHaveBeenCalledWith(
      'athmahealth/ehr',
      'tok:GITHUB_TOKEN',
      '50b124b05b',
      new Date((range.createdAt as Date).getTime() - 30 * 86_400_000),
      30,
    );
    expect(client.compareAll).toHaveBeenCalledTimes(1);
    expect(client.compareAll.mock.calls[0][2]).toBe(marker(prisma).sha);
  });

  it('honours a custom look-back', async () => {
    const { prisma, client, svc } = setup();
    const range = addRange(prisma, { kind: 'new_ref' });
    client.listBranchCommits.mockResolvedValue({
      commits: [],
      pages: 1,
      truncated: false,
    });
    client.compareAll.mockResolvedValue({
      commits: [],
      pages: 1,
      truncated: false,
    });
    await svc.runTenant(
      't1',
      readGithubAuditConfig({
        GITHUB_AUDIT_SYNC_MODE: 'ingest',
        GITHUB_AUDIT_NEW_BRANCH_LOOKBACK_DAYS: '10',
      }),
      NOW,
    );
    expect(client.listBranchCommits.mock.calls[0][3]).toEqual(
      new Date((range.createdAt as Date).getTime() - 10 * 86_400_000),
    );
  });

  it('links a new branch only to its own commits, not the history it inherited', async () => {
    const { prisma, client, svc, ingestion } = setup();
    addRange(prisma, { kind: 'new_ref', ref: 'feat-x' });
    // Own history: one new commit plus one inherited from master.
    client.listBranchCommits.mockResolvedValue({
      commits: [commit('mine', 'x'), commit('inherited', 'y')],
      pages: 1,
      truncated: false,
    });
    client.compareAll.mockResolvedValue({
      commits: [commit('mine', 'x')],
      pages: 1,
      truncated: false,
    });
    const r = await svc.runTenant('t1', INGEST, NOW);
    const keys = ingestion.ingest.mock.calls
      .map((c) => c[1].idempotencyKey as string)
      .filter((k) => k.includes(':branch:'));
    expect(keys).toEqual(['github:athmahealth/ehr:branch:feat-x:commit:mine']);
    expect(r.counters.branchLinks).toBe(1);
    // Both commits are still collected — linking is narrower than collection.
    expect(prisma.githubPushRange.rows[0]).toMatchObject({ commitsFound: 2 });
  });

  it('links every commit read when the default-branch check cannot tell', async () => {
    const { prisma, client, svc, ingestion } = setup();
    addRange(prisma, { kind: 'new_ref', ref: 'orphan' });
    client.listBranchCommits.mockResolvedValue({
      commits: [commit('o1', 'x'), commit('o2', 'y')],
      pages: 1,
      truncated: false,
    });
    client.compareAll.mockResolvedValue({
      commits: [],
      pages: 0,
      truncated: false,
      failure: 'no_common_ancestor',
    });
    await svc.runTenant('t1', INGEST, NOW);
    const branchKeys = ingestion.ingest.mock.calls
      .map((c) => c[1])
      .filter((e) => e.eventType === 'code.commit.branch_observed');
    expect(branchKeys.map((e) => e.data.sha).sort()).toEqual(['o1', 'o2']);
    expect(branchKeys[0].data).toMatchObject({
      repoFullName: 'athmahealth/ehr',
      branch: 'orphan',
      observedAt: NOW.toISOString(),
    });
  });

  it('links every commit of a moved range, including ones already present', async () => {
    const { prisma, client, svc, ingestion } = setup();
    addRange(prisma, { ref: 'ACT-1' });
    prisma.rawKeys.add('t1|github:athmahealth/ehr:commit:old');
    client.compareAll.mockResolvedValue({
      commits: [commit('old', 'x'), commit('new', 'y')],
      pages: 1,
      truncated: false,
    });
    const r = await svc.runTenant('t1', INGEST, NOW);
    const branchShas = ingestion.ingest.mock.calls
      .map((c) => c[1])
      .filter((e) => e.eventType === 'code.commit.branch_observed')
      .map((e) => e.data.sha)
      .sort();
    expect(branchShas).toEqual(['new', 'old']);
    expect(r.counters.branchLinks).toBe(2);
  });

  it('emits no branch links in shadow mode', async () => {
    const { prisma, client, svc, ingestion } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('s1', 'x')],
      pages: 1,
      truncated: false,
    });
    await svc.runTenant(
      't1',
      readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'shadow' }),
      NOW,
    );
    expect(
      ingestion.ingest.mock.calls.some(
        (c) => c[1].eventType === 'code.commit.branch_observed',
      ),
    ).toBe(false);
  });

  it('emits no branch links for a range that does not complete', async () => {
    const { prisma, client, svc, ingestion } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('f1', 'x')],
      pages: 1,
      truncated: false,
    });
    client.getCommitDetail.mockResolvedValue({}); // no stats → range fails
    await svc.runTenant('t1', INGEST, NOW);
    expect(
      ingestion.ingest.mock.calls.some(
        (c) => c[1].eventType === 'code.commit.branch_observed',
      ),
    ).toBe(false);
  });
});

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
    expect(prisma.githubPushRange.rows[0].commitOutcomes).toEqual([
      { sha: 'bbb', outcome: 'wouldIngest' },
    ]);

    const i = await svc.runTenant(
      't1',
      INGEST,
      new Date(NOW.getTime() + 300_000),
    );
    expect(i.counters.ingested).toBe(1);
    expect(prisma.githubPushRange.rows[0].status).toBe('done');
    expect(prisma.githubPushRange.rows[0].commitOutcomes).toEqual([
      { sha: 'bbb', outcome: 'ingested' },
    ]);
  });

  it('records per-commit outcomes (ingested / alreadyPresent) on a finished ingest range', async () => {
    const { prisma, client, svc } = setup();
    prisma.rawKeys.add('t1|github:athmahealth/ehr:commit:old');
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('old', 'x'), commit('new', 'x')],
      pages: 1,
      truncated: false,
    });
    await svc.runTenant('t1', INGEST, NOW);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      status: 'done',
      commitsFound: 2,
      alreadyPresent: 1,
      ingested: 1,
      commitOutcomes: [
        { sha: 'old', outcome: 'alreadyPresent' },
        { sha: 'new', outcome: 'ingested' },
      ],
    });
  });

  it('records the commits processed so far when a range fails on a missing detail', async () => {
    const { prisma, client, svc } = setup();
    prisma.rawKeys.add('t1|github:athmahealth/ehr:commit:seen');
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('seen', 'x'), commit('nodetail', 'x')],
      pages: 1,
      truncated: false,
    });
    client.getCommitDetail.mockResolvedValue({});
    await svc.runTenant('t1', INGEST, NOW);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      commitsFound: 2,
      alreadyPresent: 1,
      ingested: 0,
      commitOutcomes: [{ sha: 'seen', outcome: 'alreadyPresent' }],
    });
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

  // Rule changed 2026-10-19 (branch tracking): a moved branch whose old tip is
  // gone no longer retries a Compare against the default branch, which only
  // ever found what the branch had that master lacked. It reads the branch's
  // own history instead, like a new branch.
  it('reads a moved branch from its own history when its old tip is gone', async () => {
    const { prisma, client, svc } = setup();
    const range = addRange(prisma, {
      kind: 'moved',
      baseSha: 'gone',
      baseRef: null,
    });
    client.compareAll.mockResolvedValueOnce({
      commits: [],
      pages: 0,
      truncated: false,
      failure: 'not_found',
    });
    client.listBranchCommits.mockResolvedValue({
      commits: [commit('ddd', 'x')],
      pages: 1,
      truncated: false,
    });
    await svc.runTenant('t1', INGEST, NOW);
    expect(client.compareAll).toHaveBeenCalledTimes(1);
    expect(client.listBranchCommits).toHaveBeenCalledWith(
      'athmahealth/ehr',
      'tok:GITHUB_TOKEN',
      '50b124b05b',
      new Date((range.createdAt as Date).getTime() - 30 * 86_400_000),
      30,
    );
    expect(prisma.githubPushRange.rows[0].status).toBe('done');
  });

  it('a failed Compare stays pending with attempts+1, and becomes failed only once the cap AND the give-up age are reached', async () => {
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
      GITHUB_AUDIT_RANGE_GIVEUP_HOURS: '1',
    });
    await svc.runTenant('t1', cfg, NOW);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      status: 'pending',
      attempts: 4,
      lastAttemptAt: NOW,
    });
    // The cap is reached, but the range is only minutes old: one GitHub
    // outage must not fail it for good. It stays pending.
    const later = new Date(NOW.getTime() + 41 * 60_000);
    await svc.runTenant('t1', cfg, later);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      status: 'pending',
      attempts: 5,
    });
    // Past the give-up age, the next failure gives up.
    const muchLater = new Date(NOW.getTime() + 2 * 3_600_000);
    const r = await svc.runTenant('t1', cfg, muchLater);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      status: 'failed',
      attempts: 6,
    });
    expect(r.counters.failedRanges).toBe(1);
  });

  it('backs off a failing range: it is not retried until its backoff has passed', async () => {
    const { prisma, client, svc } = setup();
    // Failed twice: the backoff is 2 × the 5-minute interval = 10 minutes.
    addRange(prisma, { attempts: 2, lastAttemptAt: NOW });
    client.compareAll.mockResolvedValue({
      commits: [],
      pages: 0,
      truncated: false,
      failure: 'failed',
    });
    await svc.runTenant('t1', INGEST, new Date(NOW.getTime() + 5 * 60_000));
    expect(client.compareAll).not.toHaveBeenCalled();
    await svc.runTenant('t1', INGEST, new Date(NOW.getTime() + 11 * 60_000));
    expect(client.compareAll).toHaveBeenCalledTimes(1);
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

  it('re-reads a truncated Compare through the branch history and collects all of it', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('fff', 'x')],
      pages: 3,
      truncated: true,
      totalCommits: 400,
    });
    client.listBranchCommits.mockResolvedValue({
      commits: [commit('fff', 'x'), commit('ggg', 'y')],
      pages: 4,
      truncated: false,
    });
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(client.listBranchCommits).toHaveBeenCalledWith(
      'athmahealth/ehr',
      'tok:GITHUB_TOKEN',
      '50b124b05b',
      expect.any(Date),
      30,
    );
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      truncated: false,
      status: 'done',
      commitsFound: 2,
    });
    expect(r.counters).toMatchObject({ truncatedRanges: 0, comparePages: 7 });
  });

  it('keeps a range truncated when even the branch re-read cannot read it whole', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('fff', 'x')],
      pages: 3,
      truncated: true,
      totalCommits: 4000,
    });
    client.listBranchCommits.mockResolvedValue({
      commits: [commit('fff', 'x')],
      pages: 30,
      truncated: true,
    });
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      truncated: true,
      status: 'done',
    });
    expect(r.counters.truncatedRanges).toBe(1);
  });

  it('falls back to the Compare result when the branch re-read itself fails', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('fff', 'x')],
      pages: 3,
      truncated: true,
      totalCommits: 400,
    });
    client.listBranchCommits.mockResolvedValue({
      commits: [],
      pages: 0,
      truncated: false,
      failure: 'failed',
    });
    await svc.runTenant('t1', INGEST, NOW);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      truncated: true,
      status: 'done',
    });
  });

  describe('admin retry and dismiss', () => {
    it('retries a failed range with fresh attempts, for its own tenant only', async () => {
      const { prisma, svc } = setup();
      addRange(prisma, { id: 'f1', status: 'failed', attempts: 9 });
      addRange(prisma, { id: 'f2', tenantId: 't2', status: 'failed' });
      expect(await svc.retryRange('t1', 'f1')).toBe(true);
      expect(prisma.githubPushRange.rows[0]).toMatchObject({
        status: 'pending',
        attempts: 0,
        lastAttemptAt: null,
      });
      expect(await svc.retryRange('t1', 'f2')).toBe(false);
      expect(prisma.githubPushRange.rows[1].status).toBe('failed');
    });

    it('will not "retry" a range that is already done and complete', async () => {
      const { prisma, svc } = setup();
      addRange(prisma, { id: 'd1', status: 'done', truncated: false });
      expect(await svc.retryRange('t1', 'd1')).toBe(false);
    });

    it('dismisses a failed or truncated range with who and why', async () => {
      const { prisma, svc } = setup();
      addRange(prisma, { id: 'f1', status: 'failed' });
      addRange(prisma, { id: 't1r', status: 'done', truncated: true });
      expect(
        await svc.dismissRange('t1', 'f1', 'u1', 'branch deleted', NOW),
      ).toBe(true);
      expect(
        await svc.dismissRange('t1', 't1r', 'u1', 'imported history', NOW),
      ).toBe(true);
      expect(prisma.githubPushRange.rows[0]).toMatchObject({
        status: 'dismissed',
        dismissedByUserId: 'u1',
        dismissedReason: 'branch deleted',
        dismissedAt: NOW,
      });
      expect(prisma.githubPushRange.rows[1].status).toBe('dismissed');
    });
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
      expect(prisma.githubPushRange.rows[0]).toMatchObject({
        status: 'pending',
        attempts: 0,
        commitsFound: 3,
        ingested: 1,
        commitOutcomes: [{ sha: 'd1', outcome: 'ingested' }],
      });
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
      commitsFound: 2,
      ingested: 1,
      commitOutcomes: [{ sha: 'ok1', outcome: 'ingested' }],
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

  it('reads a moved branch with no common history from its own commit list, bounded by the new-branch look-back', async () => {
    const { prisma, client, svc } = setup();
    const range = addRange(prisma, { ref: 'RC4-bugs', headSha: '14753b2f' });
    client.compareAll.mockResolvedValue({
      commits: [],
      pages: 0,
      truncated: false,
      failure: 'no_common_ancestor',
    });
    client.listBranchCommits.mockResolvedValue({
      commits: [commit('orphan1', 'x')],
      pages: 1,
      truncated: false,
      status: 'unrelated_history',
    });
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(client.listBranchCommits).toHaveBeenCalledWith(
      'athmahealth/ehr',
      'tok:GITHUB_TOKEN',
      '14753b2f',
      new Date((range.createdAt as Date).getTime() - 30 * 86_400_000),
      30,
    );
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      status: 'done',
      ingested: 1,
    });
    expect(r.counters.ingested).toBe(1);
  });

  it('uses the commit-list fallback when the default-branch retry of a moved range has no common history either', async () => {
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
        commits: [],
        pages: 0,
        truncated: false,
        failure: 'no_common_ancestor',
      });
    client.listBranchCommits.mockResolvedValue({
      commits: [commit('orphan2', 'x')],
      pages: 1,
      truncated: false,
    });
    await svc.runTenant('t1', INGEST, NOW);
    expect(client.listBranchCommits).toHaveBeenCalledTimes(1);
    expect(prisma.githubPushRange.rows[0].status).toBe('done');
  });

  // Rule changed 2026-10-19: any moved range whose Compare is not_found falls
  // back to the branch's own history (the old tip was garbage-collected); a
  // failure of that read still leaves the range pending for retry.
  it('leaves a moved range pending when both the Compare and the own-history read fail', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [],
      pages: 0,
      truncated: false,
      failure: 'not_found',
    });
    client.listBranchCommits.mockResolvedValue({
      commits: [],
      pages: 0,
      truncated: false,
      failure: 'failed',
    });
    await svc.runTenant('t1', INGEST, NOW);
    expect(client.listBranchCommits).toHaveBeenCalledTimes(1);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
  });

  it('a moved range with a normal Compare never reads its own history', async () => {
    const { prisma, client, svc } = setup();
    addRange(prisma);
    client.compareAll.mockResolvedValue({
      commits: [commit('eee', 'x')],
      pages: 1,
      truncated: false,
    });
    await svc.runTenant('t1', INGEST, NOW);
    expect(client.listBranchCommits).not.toHaveBeenCalled();
  });
});

describe('commitBranchIdempotencyKey', () => {
  it('keys a commit on a branch by repo, branch and sha', () => {
    expect(
      commitBranchIdempotencyKey('athmahealth/ehr', 'ACT-1/fix', 'abc'),
    ).toBe('github:athmahealth/ehr:branch:ACT-1/fix:commit:abc');
  });
});

describe('backfillBranchLinks', () => {
  it('replays the SHAs of completed ranges as branch links, tenant-scoped and paged', async () => {
    const { prisma, svc, ingestion } = setup();
    addRange(prisma, {
      id: 'a',
      status: 'done',
      ref: 'feat-a',
      commitOutcomes: [{ sha: 's1' }, { sha: 's2' }],
      updatedAt: NOW,
    });
    addRange(prisma, {
      id: 'b',
      status: 'pending',
      commitOutcomes: [{ sha: 'p1' }],
      updatedAt: NOW,
    });
    addRange(prisma, {
      id: 'c',
      tenantId: 't2',
      status: 'done',
      commitOutcomes: [{ sha: 'x' }],
      updatedAt: NOW,
    });
    const r = await svc.backfillBranchLinks('t1');
    const branchEnvelopes = ingestion.ingest.mock.calls
      .map((c) => c[1])
      .filter((e) => e.eventType === 'code.commit.branch_observed');
    expect(branchEnvelopes.map((e) => e.idempotencyKey)).toEqual([
      'github:athmahealth/ehr:branch:feat-a:commit:s1',
      'github:athmahealth/ehr:branch:feat-a:commit:s2',
    ]);
    expect(branchEnvelopes[0].data.observedAt).toBe(NOW.toISOString());
    expect(r).toMatchObject({
      ranges: 1,
      linksAccepted: 2,
      done: true,
      nextCursor: null,
    });
  });
});
