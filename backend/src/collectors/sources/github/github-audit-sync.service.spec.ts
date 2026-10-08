import { readGithubAuditConfig } from './github-audit.config';
import { GithubAuditSyncService } from './github-audit-sync.service';
import {
  fakeIngestion,
  fakePrisma,
  seedTenant,
} from './github-audit-sync.fakes';

const NOW = new Date('2026-10-06T10:00:00Z');
const SHADOW = readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'shadow' });
const push = (id: string, repo: string, ms = NOW.getTime() - 60_000) => ({
  documentId: id,
  repoFullName: repo,
  timestamp: new Date(ms),
  actor: 'dev1',
});

function setup() {
  const prisma = fakePrisma();
  const ingestion = fakeIngestion(prisma);
  const audit = { listGitPushes: jest.fn() };
  const client = {
    listHeadRefs: jest.fn(),
    getDefaultBranch: jest.fn().mockResolvedValue({ name: 'master' }),
    compareAll: jest.fn(),
    getCommitDetail: jest.fn(),
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
  return { prisma, ingestion, audit, client, secrets, svc };
}

/** Seeds tips the way a first run would, so tests can start from "already seeded". */
function seeded(
  prisma: ReturnType<typeof fakePrisma>,
  tenantId: string,
  tips: Record<string, Record<string, string>>,
) {
  prisma.githubAuditCheckpoint.rows.push({
    id: `cp-${tenantId}`,
    tenantId,
    organization: 'acme',
    seededAt: new Date(NOW.getTime() - 3_600_000),
    checkpointAt: new Date(NOW.getTime() - 300_000),
  });
  for (const [repo, refs] of Object.entries(tips)) {
    prisma.githubRefTip.rows.push({
      id: `${repo}-HEAD`,
      tenantId,
      repoFullName: repo,
      ref: 'HEAD',
      sha: 'master',
      seenAt: NOW,
    });
    for (const [ref, sha] of Object.entries(refs)) {
      prisma.githubRefTip.rows.push({
        id: `${repo}-${ref}`,
        tenantId,
        repoFullName: repo,
        ref,
        sha,
        seenAt: NOW,
      });
    }
  }
}

describe('GithubAuditSyncService.runTenant (discovery)', () => {
  it('does nothing at all when the mode is off', async () => {
    const { svc, prisma } = setup();
    const r = await svc.runTenant('t1', readGithubAuditConfig({}), NOW);
    expect(r.status).toBe('skipped');
    expect(prisma.calls).toHaveLength(0);
  });

  it('skips a tenant with no audit-log token ref, saying why', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['acme/ehr'], {});
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r).toMatchObject({ status: 'skipped' });
    expect(r.reason).toMatch(/audit-log token/i);
  });

  it('first run seeds every repo, calls no audit log, and starts the checkpoint at seeding', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/amma']);
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([
        ['master', 'm1'],
        ['feat', 'f1'],
      ]),
    });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('seeded');
    expect(r.counters.reposSeeded).toBe(2);
    expect(audit.listGitPushes).not.toHaveBeenCalled();
    expect(prisma.githubAuditCheckpoint.rows[0]).toMatchObject({
      seededAt: NOW,
      checkpointAt: NOW,
    });
    expect(
      prisma.githubRefTip.rows
        .filter((t) => t.repoFullName === 'acme/ehr')
        .map((t) => t.ref)
        .sort(),
    ).toEqual(['HEAD', 'feat', 'master']);
    expect(prisma.githubPushRange.rows).toHaveLength(0);
  });

  it('does not start the checkpoint when seeding fails transiently for any repo', async () => {
    // Final-review ruling I-1: only TRANSIENT failures (failed / rate_limited)
    // block seeding; a 404/403 repo is unseedable and skipped (next test).
    // The checkpoint row now exists from the run claim (I-3), so the
    // assertion is "seededAt/checkpointAt not set" rather than "no row".
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/flaky']);
    client.listHeadRefs.mockImplementation(async (repo: string) =>
      repo === 'acme/flaky'
        ? { failure: 'failed' }
        : { tips: new Map([['master', 'm1']]) },
    );
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('partial');
    expect(r.counters.reposUnseedable).toBe(0);
    expect(prisma.githubAuditCheckpoint.rows[0].seededAt ?? null).toBeNull();
    expect(
      prisma.githubAuditCheckpoint.rows[0].checkpointAt ?? null,
    ).toBeNull();
  });

  it('skips a 404 repo as unseedable: seeding completes, the repo is counted and named', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/gone', 'acme/amma']);
    client.listHeadRefs.mockImplementation(async (repo: string) =>
      repo === 'acme/gone'
        ? { failure: 'not_found' }
        : { tips: new Map([['master', 'm1']]) },
    );
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('seeded');
    expect(r.counters).toMatchObject({ reposSeeded: 2, reposUnseedable: 1 });
    expect(prisma.githubAuditRun.rows[0].error).toContain('acme/gone');
    expect(prisma.githubAuditCheckpoint.rows[0]).toMatchObject({
      seededAt: NOW,
      checkpointAt: NOW,
    });
  });

  it('does not list refs for a repo whose default-branch read failed', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/private']);
    client.getDefaultBranch.mockImplementation(async (repo: string) =>
      repo === 'acme/private' ? { failure: 'forbidden' } : { name: 'master' },
    );
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([['master', 'm1']]),
    });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('seeded');
    expect(r.counters.reposUnseedable).toBe(1);
    expect(client.listHeadRefs.mock.calls.map((c) => c[0])).toEqual([
      'acme/ehr',
    ]);
  });

  it('seeds an empty repository (no branches) with the HEAD marker only', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/empty']);
    client.listHeadRefs.mockResolvedValue({ tips: new Map() });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('seeded');
    expect(prisma.githubRefTip.rows.map((t) => t.ref)).toEqual(['HEAD']);
  });

  it('stops seeding further repos once the core budget (above the reserve) is spent', async () => {
    const { svc, prisma, client } = setup();
    const originalReserve = process.env.GITHUB_BACKFILL_RATE_RESERVE;
    process.env.GITHUB_BACKFILL_RATE_RESERVE = '1000';
    try {
      seedTenant(prisma, 't1', ['acme/a', 'acme/b', 'acme/c']);
      client.getDefaultBranch.mockResolvedValue({
        name: 'master',
        rateLimit: { remaining: 1002, resetAt: NOW },
      });
      client.listHeadRefs.mockResolvedValue({
        tips: new Map([['master', 'm1']]),
        rateLimit: { remaining: 1001, resetAt: NOW },
      });
      const cfg = readGithubAuditConfig({
        GITHUB_AUDIT_SYNC_MODE: 'shadow',
        GITHUB_AUDIT_COMPARE_CONCURRENCY: '1',
      });
      const r = await svc.runTenant('t1', cfg, NOW);
      // (1002 - 1000) - 1 = 1 after the branch read; (1001 - 1000) - 1 = 0
      // after the listing → stop before acme/b.
      expect(client.getDefaultBranch).toHaveBeenCalledTimes(1);
      expect(r.status).toBe('partial');
      expect(r.counters.reposSeeded).toBe(1);
      expect(prisma.githubAuditRun.rows[0].error).toMatch(/reserve/i);
      expect(prisma.githubAuditCheckpoint.rows[0].seededAt ?? null).toBeNull();
    } finally {
      if (originalReserve === undefined) {
        delete process.env.GITHUB_BACKFILL_RATE_RESERVE;
      } else {
        process.env.GITHUB_BACKFILL_RATE_RESERVE = originalReserve;
      }
    }
  });

  it('reads the audit window from checkpoint minus overlap with per_page 100', async () => {
    const { svc, prisma, audit } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    audit.listGitPushes.mockResolvedValue({
      status: 'complete',
      events: [],
      pages: 1,
      nextTraversals: 0,
    });
    await svc.runTenant('t1', SHADOW, NOW);
    expect(audit.listGitPushes).toHaveBeenCalledWith(
      'acme',
      'tok:GITHUB_AUDIT_TOKEN',
      new Date(NOW.getTime() - 300_000 - 15 * 60_000),
      100,
      200,
    );
  });

  it('keeps the checkpoint and plans nothing when the audit log is incomplete', async () => {
    const { svc, prisma, audit } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    const before = prisma.githubAuditCheckpoint.rows[0].checkpointAt;
    audit.listGitPushes.mockResolvedValue({
      status: 'failed',
      pages: 2,
      message: 'HTTP 502',
    });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('failed');
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(before);
    expect(prisma.githubPushRange.rows).toHaveLength(0);
  });

  it('stores pushes, plans one range per moved ref per repo, skips unregistered repos, advances the checkpoint', async () => {
    const { svc, prisma, audit, client, ingestion } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/amma']);
    seeded(prisma, 't1', {
      'acme/ehr': { master: 'm1', 'feature-A': 'A', 'feature-B': 'X' },
      'acme/amma': { master: 'm2', 'feature-X': 'P' },
    });
    audit.listGitPushes.mockResolvedValue({
      status: 'complete',
      pages: 1,
      nextTraversals: 0,
      events: [
        push('e1', 'acme/ehr'),
        push('e2', 'acme/ehr'),
        push('e3', 'acme/ehr'),
        push('e4', 'acme/ehr'),
        push('e5', 'acme/ehr'),
        push('e6', 'acme/amma'),
        push('e7', 'acme/not-registered'),
      ],
    });
    client.listHeadRefs.mockImplementation(async (repo: string) =>
      repo === 'acme/ehr'
        ? {
            tips: new Map([
              ['master', 'm1'],
              ['feature-A', 'D'],
              ['feature-B', 'Z'],
            ]),
          }
        : {
            tips: new Map([
              ['master', 'm2'],
              ['feature-X', 'Q'],
            ]),
          },
    );
    const r = await svc.runTenant('t1', SHADOW, NOW);

    expect(r.status).toBe('success');
    expect(r.counters).toMatchObject({
      auditEvents: 7,
      uniquePushes: 7,
      reposTouched: 2,
      reposUnregistered: 1,
      // Final-review ruling: naive counts only pushes to registered repos
      // that were already seeded at plan time (e7 is unregistered) — was 7/4.
      compareCandidatesNaive: 6,
      compareRequestsPlanned: 3,
      compareRequestsSaved: 3,
      refsMoved: 3,
    });
    const ranges = prisma.githubPushRange.rows
      .map((x) => `${x.repoFullName}:${x.ref}:${x.baseSha}...${x.headSha}`)
      .sort();
    expect(ranges).toEqual([
      'acme/amma:feature-X:P...Q',
      'acme/ehr:feature-A:A...D',
      'acme/ehr:feature-B:X...Z',
    ]);
    expect(
      prisma.githubPushRange.rows.find((x) => x.ref === 'feature-A')!
        .auditDocumentIds,
    ).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    const pushKeys = ingestion.ingest.mock.calls.map(
      (c) => c[1].idempotencyKey,
    );
    expect(pushKeys).toEqual(
      expect.arrayContaining(['github:audit:e1', 'github:audit:e6']),
    );
    expect(pushKeys).not.toContain('github:audit:e7');
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(NOW);
  });

  it('is idempotent across overlapping windows: the same pushes plan nothing the second time', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1', f: 'A' } });
    audit.listGitPushes.mockResolvedValue({
      status: 'complete',
      pages: 1,
      nextTraversals: 0,
      events: [push('e1', 'acme/ehr')],
    });
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([
        ['master', 'm1'],
        ['f', 'B'],
      ]),
    });
    await svc.runTenant('t1', SHADOW, NOW);
    await svc.runTenant('t1', SHADOW, new Date(NOW.getTime() + 300_000));
    expect(prisma.githubPushRange.rows).toHaveLength(1);
  });

  it('does not advance the checkpoint when a touched repo cannot be listed, but keeps other repos planned', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/amma']);
    seeded(prisma, 't1', {
      'acme/ehr': { master: 'm1', f: 'A' },
      'acme/amma': { master: 'm2' },
    });
    const before = prisma.githubAuditCheckpoint.rows[0].checkpointAt;
    audit.listGitPushes.mockResolvedValue({
      status: 'complete',
      pages: 1,
      nextTraversals: 0,
      events: [push('e1', 'acme/ehr'), push('e2', 'acme/amma')],
    });
    client.listHeadRefs.mockImplementation(async (repo: string) =>
      repo === 'acme/ehr'
        ? {
            tips: new Map([
              ['master', 'm1'],
              ['f', 'B'],
            ]),
          }
        : { failure: 'failed' },
    );
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('failed');
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(before);
    expect(prisma.githubPushRange.rows).toHaveLength(1);
  });

  it('skips a touched repo that now 404s without holding the checkpoint', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/gone']);
    seeded(prisma, 't1', {
      'acme/ehr': { master: 'm1', f: 'A' },
      'acme/gone': { master: 'g1' },
    });
    audit.listGitPushes.mockResolvedValue({
      status: 'complete',
      pages: 1,
      nextTraversals: 0,
      events: [push('e1', 'acme/ehr'), push('e2', 'acme/gone')],
    });
    client.listHeadRefs.mockImplementation(async (repo: string) =>
      repo === 'acme/gone'
        ? { failure: 'not_found' }
        : {
            tips: new Map([
              ['master', 'm1'],
              ['f', 'B'],
            ]),
          },
    );
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('success');
    expect(r.counters.reposUnseedable).toBe(1);
    expect(r.counters.compareCandidatesNaive).toBe(1);
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(NOW);
    expect(prisma.githubAuditRun.rows[0].error).toContain('acme/gone');
  });

  it('skips a never-seen touched repo that 404s on seeding without holding the checkpoint', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/gone']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    audit.listGitPushes.mockResolvedValue({
      status: 'complete',
      pages: 1,
      nextTraversals: 0,
      events: [push('e1', 'acme/gone')],
    });
    client.getDefaultBranch.mockResolvedValue({ failure: 'not_found' });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('success');
    expect(r.counters).toMatchObject({ reposUnseedable: 1, reposSeeded: 0 });
    expect(r.counters.compareCandidatesNaive).toBe(0);
    expect(client.listHeadRefs).not.toHaveBeenCalled();
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(NOW);
  });

  it('holds the checkpoint when the core budget runs out before every touched repo is listed', async () => {
    const { svc, prisma, audit, client } = setup();
    const originalReserve = process.env.GITHUB_BACKFILL_RATE_RESERVE;
    process.env.GITHUB_BACKFILL_RATE_RESERVE = '1000';
    try {
      seedTenant(prisma, 't1', ['acme/ehr', 'acme/amma']);
      seeded(prisma, 't1', {
        'acme/ehr': { master: 'm1' },
        'acme/amma': { master: 'm2' },
      });
      const before = prisma.githubAuditCheckpoint.rows[0].checkpointAt;
      audit.listGitPushes.mockResolvedValue({
        status: 'complete',
        pages: 1,
        nextTraversals: 0,
        events: [push('e1', 'acme/ehr'), push('e2', 'acme/amma')],
      });
      client.listHeadRefs.mockResolvedValue({
        tips: new Map([['master', 'm1']]),
        rateLimit: { remaining: 1000, resetAt: NOW },
      });
      const cfg = readGithubAuditConfig({
        GITHUB_AUDIT_SYNC_MODE: 'shadow',
        GITHUB_AUDIT_COMPARE_CONCURRENCY: '1',
      });
      const r = await svc.runTenant('t1', cfg, NOW);
      expect(client.listHeadRefs).toHaveBeenCalledTimes(1);
      expect(r.status).toBe('failed');
      expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(before);
      expect(prisma.githubAuditRun.rows[0].error).toMatch(/reserve/i);
    } finally {
      if (originalReserve === undefined) {
        delete process.env.GITHUB_BACKFILL_RATE_RESERVE;
      } else {
        process.env.GITHUB_BACKFILL_RATE_RESERVE = originalReserve;
      }
    }
  });

  it('seeds (no range) a touched repo it has never seen', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/new']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    audit.listGitPushes.mockResolvedValue({
      status: 'complete',
      pages: 1,
      nextTraversals: 0,
      events: [push('e1', 'acme/new')],
    });
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([
        ['main', 'n1'],
        ['b', 'n2'],
      ]),
    });
    client.getDefaultBranch.mockResolvedValue({ name: 'main' });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.counters.reposSeeded).toBe(1);
    expect(prisma.githubPushRange.rows).toHaveLength(0);
    expect(
      prisma.githubRefTip.rows.find(
        (t) => t.repoFullName === 'acme/new' && t.ref === 'HEAD',
      )!.sha,
    ).toBe('main');
  });

  it('flags a checkpoint older than six days as a retention risk', async () => {
    const { svc, prisma, audit } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    prisma.githubAuditCheckpoint.rows[0].checkpointAt = new Date(
      NOW.getTime() - 6.5 * 86_400_000,
    );
    audit.listGitPushes.mockResolvedValue({
      status: 'failed',
      pages: 0,
      message: 'x',
    });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(prisma.githubAuditRun.rows[0].error).toMatch(/retention/i);
    expect(r.status).toBe('failed');
  });

  it('flags retention risk on a SUCCESSFUL run too, measured against the checkpoint from before this run advanced it', async () => {
    const { svc, prisma, audit } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    prisma.githubAuditCheckpoint.rows[0].checkpointAt = new Date(
      NOW.getTime() - 6.5 * 86_400_000,
    );
    audit.listGitPushes.mockResolvedValue({
      status: 'complete',
      events: [],
      pages: 1,
      nextTraversals: 0,
    });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('success');
    expect(prisma.githubAuditRun.rows[0].error).toMatch(/retention/i);
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(NOW);
  });

  it('does not reject when loading registered repos throws, and does not leave a run row stuck', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    prisma.connection.findMany.mockRejectedValueOnce(new Error('db down'));
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('failed');
    expect(prisma.githubAuditRun.rows).toHaveLength(0);
  });

  it('touches only the running tenant (tenant isolation)', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seedTenant(prisma, 't2', ['other/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1', f: 'A' } });
    seeded(prisma, 't2', { 'other/ehr': { master: 'z1', f: 'Z' } });
    audit.listGitPushes.mockResolvedValue({
      status: 'complete',
      pages: 1,
      nextTraversals: 0,
      events: [push('e1', 'acme/ehr'), push('e2', 'other/ehr')],
    });
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([
        ['master', 'm1'],
        ['f', 'B'],
      ]),
    });
    await svc.runTenant('t1', SHADOW, NOW);
    for (const call of prisma.calls) {
      const blob = JSON.stringify(call);
      expect(blob).not.toContain('"t2"');
    }
    expect(
      prisma.githubRefTip.rows.find(
        (t) => t.tenantId === 't2' && t.ref === 'f',
      )!.sha,
    ).toBe('Z');
  });
});

describe('GithubAuditSyncService.runTenant (per-tenant run claim)', () => {
  const emptyAudit = {
    status: 'complete',
    events: [],
    pages: 1,
    nextTraversals: 0,
  };

  it('skips, without creating a run row, while another run holds the claim', async () => {
    const { svc, prisma, audit } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    const held = new Date(NOW.getTime() - 5 * 60_000);
    prisma.githubAuditCheckpoint.rows[0].runningSince = held;
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r).toMatchObject({
      status: 'skipped',
      reason: 'Another audit sync run for this tenant is in progress.',
    });
    expect(prisma.githubAuditRun.rows).toHaveLength(0);
    expect(audit.listGitPushes).not.toHaveBeenCalled();
    expect(prisma.githubAuditCheckpoint.rows[0].runningSince).toBe(held);
  });

  it('lets only one of two concurrent calls run', async () => {
    const { svc, prisma, audit } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    audit.listGitPushes.mockResolvedValue(emptyAudit);
    const results = await Promise.all([
      svc.runTenant('t1', SHADOW, NOW),
      svc.runTenant('t1', SHADOW, NOW),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual(['skipped', 'success']);
    expect(prisma.githubAuditRun.rows).toHaveLength(1);
    expect(
      prisma.githubAuditCheckpoint.rows[0].runningSince ?? null,
    ).toBeNull();
  });

  it('takes over a stale claim (older than 60 minutes)', async () => {
    const { svc, prisma, audit } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    prisma.githubAuditCheckpoint.rows[0].runningSince = new Date(
      NOW.getTime() - 61 * 60_000,
    );
    audit.listGitPushes.mockResolvedValue(emptyAudit);
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('success');
    expect(
      prisma.githubAuditCheckpoint.rows[0].runningSince ?? null,
    ).toBeNull();
  });

  it('creates the checkpoint row to claim on a first run, and still sets seededAt/checkpointAt', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([['master', 'm1']]),
    });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('seeded');
    expect(prisma.githubAuditCheckpoint.rows).toHaveLength(1);
    expect(prisma.githubAuditCheckpoint.rows[0]).toMatchObject({
      organization: 'acme',
      seededAt: NOW,
      checkpointAt: NOW,
    });
    expect(
      prisma.githubAuditCheckpoint.rows[0].runningSince ?? null,
    ).toBeNull();
  });

  it('releases the claim after a failed run', async () => {
    const { svc, prisma, audit } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    audit.listGitPushes.mockResolvedValue({
      status: 'failed',
      pages: 0,
      message: 'HTTP 502',
    });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('failed');
    expect(
      prisma.githubAuditCheckpoint.rows[0].runningSince ?? null,
    ).toBeNull();
  });

  it('releases the claim when the run throws', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    prisma.githubAuditRun.create.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.runTenant('t1', SHADOW, NOW)).rejects.toThrow('db down');
    expect(
      prisma.githubAuditCheckpoint.rows[0].runningSince ?? null,
    ).toBeNull();
  });
});
