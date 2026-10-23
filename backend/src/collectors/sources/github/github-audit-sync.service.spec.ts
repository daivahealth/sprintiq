import { readGithubAuditConfig } from './github-audit.config';
import {
  RUN_CLAIM_HEARTBEAT_MS,
  GithubAuditSyncService,
  SHADOW_REPLAY_MS,
} from './github-audit-sync.service';
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
  // Stand-in for ConnectionsService over the same fake connection table, so a
  // registered connection is visible to the next run's `registeredRepos`.
  const connections = {
    findByTenantSourceAndName: jest.fn(
      async (tenantId: string, sourceSystem: string, name: string) =>
        prisma.connection.rows.find(
          (r) =>
            r.tenantId === tenantId &&
            r.sourceSystem === sourceSystem &&
            r.name === name,
        ) ?? null,
    ),
    create: jest.fn(
      async (tenantId: string, input: Record<string, unknown>) => {
        const row = {
          id: `new-${String(input.name)}`,
          tenantId,
          status: 'active',
          ...input,
        };
        prisma.connection.rows.push(row);
        return row;
      },
    ),
  };
  const auditSink = { record: jest.fn(async () => undefined) };
  const svc = new GithubAuditSyncService(
    prisma as never,
    secrets as never,
    ingestion as never,
    audit as never,
    client as never,
    connections as never,
    auditSink as never,
  );
  return {
    prisma,
    ingestion,
    audit,
    client,
    secrets,
    connections,
    auditSink,
    svc,
  };
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
    // Three repos so one `forbidden` repo is below the refusal-guard's
    // half threshold (1/3), keeping this scenario distinct from the
    // refusal-guard tests below.
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/private', 'acme/amma']);
    client.getDefaultBranch.mockImplementation(async (repo: string) =>
      repo === 'acme/private' ? { failure: 'forbidden' } : { name: 'master' },
    );
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([['master', 'm1']]),
    });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('seeded');
    expect(r.counters.reposUnseedable).toBe(1);
    expect(client.listHeadRefs.mock.calls.map((c) => c[0]).sort()).toEqual([
      'acme/amma',
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

  it('stores pushes, plans one range per moved ref per repo, skips a repo whose connection is disabled, advances the checkpoint', async () => {
    const { svc, prisma, audit, client, ingestion, connections } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/amma']);
    // Task 3 (auto-registration): a pushed repo with NO connection at all is
    // now registered, so "skipped as unregistered" only still applies to a
    // repo whose connection exists but is not active — an admin decision the
    // audit sync must leave alone. That is the case this test now pins.
    prisma.connection.rows.push({
      id: 't1-conn-disabled',
      tenantId: 't1',
      sourceSystem: 'github',
      status: 'disabled',
      name: 'acme/not-registered',
      secretRef: 'GITHUB_TOKEN',
      config: { repoFullName: 'acme/not-registered' },
    });
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
    expect(r.counters.reposRegistered).toBe(0);
    expect(connections.create).not.toHaveBeenCalled();
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
    const { svc, prisma, audit, client, connections } = setup();
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
    // `other/ehr` has no connection IN t1, so t1's run may register it — but
    // only ever as a t1 connection; t2's own connection is never looked at.
    for (const call of [
      ...connections.findByTenantSourceAndName.mock.calls,
      ...connections.create.mock.calls,
    ]) {
      expect(call[0]).toBe('t1');
    }
    expect(
      prisma.connection.rows.filter((c) => c.tenantId === 't2'),
    ).toHaveLength(1);
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

  it('takes over a claim not refreshed for more than 10 minutes, but not a fresher one', async () => {
    const { svc, prisma, audit } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    audit.listGitPushes.mockResolvedValue(emptyAudit);
    prisma.githubAuditCheckpoint.rows[0].runningSince = new Date(
      NOW.getTime() - 9 * 60_000,
    );
    expect((await svc.runTenant('t1', SHADOW, NOW)).status).toBe('skipped');
    prisma.githubAuditCheckpoint.rows[0].runningSince = new Date(
      NOW.getTime() - 11 * 60_000,
    );
    expect((await svc.runTenant('t1', SHADOW, NOW)).status).toBe('success');
  });

  it('keeps refreshing its claim during a long run, and releases the refreshed claim', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const { svc, prisma, audit } = setup();
      seedTenant(prisma, 't1', ['acme/ehr']);
      seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
      let finish!: (v: unknown) => void;
      audit.listGitPushes.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const run = svc.runTenant('t1', SHADOW, NOW);
      // Let the claim land before the clock moves.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(prisma.githubAuditCheckpoint.rows[0].runningSince).toEqual(NOW);
      // 25 minutes of a slow run: far past the 10-minute stale threshold.
      for (let m = 0; m < 25; m += 2) {
        await jest.advanceTimersByTimeAsync(RUN_CLAIM_HEARTBEAT_MS);
      }
      const refreshed = prisma.githubAuditCheckpoint.rows[0].runningSince;
      expect(refreshed.getTime()).toBeGreaterThan(NOW.getTime() + 20 * 60_000);
      // A second run now sees a fresh claim and stays out.
      expect(
        (
          await svc.runTenant(
            't1',
            SHADOW,
            new Date(NOW.getTime() + 26 * 60_000),
          )
        ).status,
      ).toBe('skipped');
      finish(emptyAudit);
      await run;
      expect(
        prisma.githubAuditCheckpoint.rows[0].runningSince ?? null,
      ).toBeNull();
    } finally {
      jest.useRealTimers();
    }
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

describe('GithubAuditSyncService.runTenant (org-wide refusal guard)', () => {
  it('fails the run, leaving seededAt unset, when every repo is forbidden', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/a', 'acme/b', 'acme/c', 'acme/d']);
    client.getDefaultBranch.mockResolvedValue({ failure: 'forbidden' });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(
      /collector token refused \(403\/404\) for 4 of 4 repos — check token scope, SSO authorization and that these repos still exist/,
    );
    expect(prisma.githubAuditCheckpoint.rows[0].seededAt ?? null).toBeNull();
    expect(
      prisma.githubAuditCheckpoint.rows[0].checkpointAt ?? null,
    ).toBeNull();
  });

  it('fails the run when at least half (3 of 4) of the attempted repos are forbidden', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/a', 'acme/b', 'acme/c', 'acme/d']);
    client.getDefaultBranch.mockImplementation(async (repo: string) =>
      repo === 'acme/d' ? { name: 'master' } : { failure: 'forbidden' },
    );
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([['master', 'm1']]),
    });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(
      /collector token refused \(403\/404\) for 3 of 4 repos — check token scope, SSO authorization and that these repos still exist/,
    );
    expect(prisma.githubAuditCheckpoint.rows[0].seededAt ?? null).toBeNull();
  });

  it('fails the run when every repo returns 404, not just 403 (org-wide access loss usually shows up as 404)', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/a', 'acme/b', 'acme/c', 'acme/d']);
    client.getDefaultBranch.mockResolvedValue({ failure: 'not_found' });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(
      /collector token refused \(403\/404\) for 4 of 4 repos — check token scope, SSO authorization and that these repos still exist/,
    );
    expect(prisma.githubAuditCheckpoint.rows[0].seededAt ?? null).toBeNull();
  });

  it('fails the run when 2 of 4 repos return 404 and 0 return 403 (ratio reaches half)', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/a', 'acme/b', 'acme/c', 'acme/d']);
    client.getDefaultBranch.mockImplementation(async (repo: string) =>
      repo === 'acme/a' || repo === 'acme/b'
        ? { failure: 'not_found' }
        : { name: 'master' },
    );
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([['master', 'm1']]),
    });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(
      /collector token refused \(403\/404\) for 2 of 4 repos/,
    );
    expect(prisma.githubAuditCheckpoint.rows[0].seededAt ?? null).toBeNull();
  });

  it('fails the run when a mix of 403 and 404 together reach half the attempted repos', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/a', 'acme/b', 'acme/c', 'acme/d']);
    client.getDefaultBranch.mockImplementation(async (repo: string) => {
      if (repo === 'acme/a') return { failure: 'forbidden' };
      if (repo === 'acme/b') return { failure: 'not_found' };
      return { name: 'master' };
    });
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([['master', 'm1']]),
    });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(
      /collector token refused \(403\/404\) for 2 of 4 repos/,
    );
    expect(prisma.githubAuditCheckpoint.rows[0].seededAt ?? null).toBeNull();
  });

  it('stays partial when every attempted repo fails transiently, with none refused', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/a', 'acme/b', 'acme/c']);
    client.getDefaultBranch.mockResolvedValue({ failure: 'failed' });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('partial');
    expect(r.counters.reposUnseedable).toBe(0);
    expect(prisma.githubAuditCheckpoint.rows[0].seededAt ?? null).toBeNull();
  });

  it('still seeds when only 1 of 4 attempted repos is forbidden', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/a', 'acme/b', 'acme/c', 'acme/d']);
    client.getDefaultBranch.mockImplementation(async (repo: string) =>
      repo === 'acme/a' ? { failure: 'forbidden' } : { name: 'master' },
    );
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([['master', 'm1']]),
    });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('seeded');
    expect(r.counters.reposUnseedable).toBe(1);
    expect(prisma.githubAuditCheckpoint.rows[0]).toMatchObject({
      seededAt: NOW,
      checkpointAt: NOW,
    });
  });

  it('does not apply the refusal guard outside the seeding pass (a 403 on a never-seen touched repo)', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/gone']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    audit.listGitPushes.mockResolvedValue({
      status: 'complete',
      pages: 1,
      nextTraversals: 0,
      events: [push('e1', 'acme/gone')],
    });
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([['master', 'm1']]),
    });
    client.getDefaultBranch.mockImplementation(async (repo: string) =>
      repo === 'acme/gone' ? { failure: 'forbidden' } : { name: 'master' },
    );
    const r = await svc.runTenant('t1', SHADOW, NOW);
    // Only one repo (acme/gone) was ever touched by planRepo's own seeding —
    // the refusal guard is scoped to the initial seedAll pass, so a single
    // forbidden repo discovered via the audit log never fails the whole run.
    expect(r.status).toBe('success');
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(NOW);
  });
});

describe('GithubAuditSyncService.runTenant (lag visibility)', () => {
  it('records a lag warning in run.error when the pre-run checkpoint is older than the threshold', async () => {
    const { svc, prisma, audit } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    prisma.githubAuditCheckpoint.rows[0].checkpointAt = new Date(
      NOW.getTime() - 45 * 60_000,
    );
    audit.listGitPushes.mockResolvedValue({
      status: 'complete',
      events: [],
      pages: 1,
      nextTraversals: 0,
    });
    const cfg = readGithubAuditConfig({
      GITHUB_AUDIT_SYNC_MODE: 'shadow',
      GITHUB_AUDIT_LAG_WARN_MINUTES: '30',
    });
    const r = await svc.runTenant('t1', cfg, NOW);
    expect(r.status).toBe('success');
    expect(prisma.githubAuditRun.rows[0].error).toMatch(
      /Audit sync is 45 minutes behind\./,
    );
  });

  it('does not warn when the pre-run checkpoint is within the threshold', async () => {
    const { svc, prisma, audit } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    prisma.githubAuditCheckpoint.rows[0].checkpointAt = new Date(
      NOW.getTime() - 5 * 60_000,
    );
    audit.listGitPushes.mockResolvedValue({
      status: 'complete',
      events: [],
      pages: 1,
      nextTraversals: 0,
    });
    const cfg = readGithubAuditConfig({
      GITHUB_AUDIT_SYNC_MODE: 'shadow',
      GITHUB_AUDIT_LAG_WARN_MINUTES: '30',
    });
    const r = await svc.runTenant('t1', cfg, NOW);
    expect(r.status).toBe('success');
    expect(prisma.githubAuditRun.rows[0].error ?? null).toBeNull();
  });

  it('uses max(lag threshold, 2 × interval): a 60-minute interval does not warn at 65 or 120 minutes but does past 120', async () => {
    const cfg = readGithubAuditConfig({
      GITHUB_AUDIT_SYNC_MODE: 'shadow',
      GITHUB_AUDIT_LAG_WARN_MINUTES: '30',
      GITHUB_AUDIT_SYNC_INTERVAL_MINUTES: '60',
    });
    const run = async (lagMinutes: number) => {
      const { svc, prisma, audit } = setup();
      seedTenant(prisma, 't1', ['acme/ehr']);
      seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
      prisma.githubAuditCheckpoint.rows[0].checkpointAt = new Date(
        NOW.getTime() - lagMinutes * 60_000,
      );
      audit.listGitPushes.mockResolvedValue({
        status: 'complete',
        events: [],
        pages: 1,
        nextTraversals: 0,
      });
      await svc.runTenant('t1', cfg, NOW);
      return (prisma.githubAuditRun.rows[0].error ?? null) as string | null;
    };
    expect(await run(65)).toBeNull();
    expect(await run(120)).toBeNull();
    expect(await run(121)).toMatch(/Audit sync is 121 minutes behind\./);
  });

  it('never warns before seeding exists (no pre-run checkpoint at all)', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([['master', 'm1']]),
    });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('seeded');
    expect(prisma.githubAuditRun.rows[0].error ?? null).toBeNull();
  });

  it('puts the lag sentence before the retention-risk warning when both apply', async () => {
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
    const error = prisma.githubAuditRun.rows[0].error as string;
    const lagIndex = error.indexOf('minutes behind');
    const retentionIndex = error.indexOf('Retention risk');
    expect(lagIndex).toBeGreaterThanOrEqual(0);
    expect(retentionIndex).toBeGreaterThan(lagIndex);
  });
});

describe('GithubAuditSyncService.status', () => {
  it('reports mode, enabled, lag and range counts for the tenant', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    prisma.githubAuditCheckpoint.rows[0].checkpointAt = new Date(
      NOW.getTime() - 45 * 60_000,
    );
    prisma.githubAuditCheckpoint.rows[0].lastRunAt = NOW;
    prisma.githubAuditCheckpoint.rows[0].lastStatus = 'success';
    prisma.githubAuditCheckpoint.rows[0].lastError = null;
    prisma.githubPushRange.rows.push(
      { id: 'r1', tenantId: 't1', status: 'pending' },
      { id: 'r2', tenantId: 't1', status: 'pending' },
      { id: 'r3', tenantId: 't1', status: 'failed' },
    );
    const cfg = readGithubAuditConfig({
      GITHUB_AUDIT_SYNC_MODE: 'ingest',
      GITHUB_AUDIT_LAG_WARN_MINUTES: '30',
    });
    const status = await svc.status('t1', cfg, NOW);
    expect(status).toMatchObject({
      mode: 'ingest',
      enabled: true,
      lagMinutes: 45,
      behind: true,
      lastRunAt: NOW,
      lastStatus: 'success',
      lastError: null,
      pendingRanges: 2,
      failedRanges: 1,
    });
  });

  it('counts truncated and dismissed ranges for the admin panel', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    prisma.githubPushRange.rows.push(
      { id: 'a', tenantId: 't1', status: 'done', truncated: true },
      { id: 'b', tenantId: 't1', status: 'done', truncated: false },
      { id: 'c', tenantId: 't1', status: 'dismissed', truncated: true },
      { id: 'd', tenantId: 't2', status: 'done', truncated: true },
    );
    expect(await svc.status('t1', SHADOW, NOW)).toMatchObject({
      truncatedRanges: 1,
      dismissedRanges: 1,
    });
  });

  it('judges behind against max(lag threshold, 2 × interval)', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    const cfg = readGithubAuditConfig({
      GITHUB_AUDIT_SYNC_MODE: 'ingest',
      GITHUB_AUDIT_LAG_WARN_MINUTES: '30',
      GITHUB_AUDIT_SYNC_INTERVAL_MINUTES: '60',
    });
    prisma.githubAuditCheckpoint.rows[0].checkpointAt = new Date(
      NOW.getTime() - 90 * 60_000,
    );
    expect((await svc.status('t1', cfg, NOW)).behind).toBe(false);
    prisma.githubAuditCheckpoint.rows[0].checkpointAt = new Date(
      NOW.getTime() - 121 * 60_000,
    );
    expect((await svc.status('t1', cfg, NOW)).behind).toBe(true);
  });

  it('is not enabled when no audit-log token ref is configured', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['acme/ehr'], {});
    const status = await svc.status('t1', readGithubAuditConfig({}), NOW);
    expect(status.enabled).toBe(false);
  });

  it('reports a null lag when there is no checkpoint yet', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    const status = await svc.status('t1', readGithubAuditConfig({}), NOW);
    expect(status.lagMinutes).toBeNull();
    expect(status.behind).toBe(false);
  });

  it('reads only the requested tenant (tenant isolation)', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seedTenant(prisma, 't2', ['other/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    seeded(prisma, 't2', { 'other/ehr': { master: 'z1' } });
    prisma.githubPushRange.rows.push(
      { id: 'r1', tenantId: 't2', status: 'pending' },
      { id: 'r2', tenantId: 't2', status: 'failed' },
    );
    const status = await svc.status('t1', readGithubAuditConfig({}), NOW);
    expect(status.pendingRanges).toBe(0);
    expect(status.failedRanges).toBe(0);
  });

  it('reports a null lastFullSweep when no full sweep has run', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    const status = await svc.status('t1', readGithubAuditConfig({}), NOW);
    expect(status.lastFullSweep).toBeNull();
  });

  it('reports the latest of two full sweeps', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    prisma.githubAuditRun.rows.push(
      {
        id: 'sweep-1',
        tenantId: 't1',
        trigger: 'full_sweep',
        status: 'success',
        startedAt: new Date('2026-10-04T18:50:00.000Z'),
        finishedAt: new Date('2026-10-04T19:00:00.000Z'),
      },
      {
        id: 'sweep-2',
        tenantId: 't1',
        trigger: 'full_sweep',
        status: 'partial',
        startedAt: new Date('2026-10-05T18:50:00.000Z'),
        finishedAt: new Date('2026-10-05T19:00:00.000Z'),
      },
    );
    const status = await svc.status('t1', readGithubAuditConfig({}), NOW);
    expect(status.lastFullSweep).toEqual({
      startedAt: new Date('2026-10-05T18:50:00.000Z'),
      finishedAt: new Date('2026-10-05T19:00:00.000Z'),
      status: 'partial',
    });
  });

  it("ignores another tenant's full sweep (tenant isolation)", async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seedTenant(prisma, 't2', ['other/ehr']);
    prisma.githubAuditRun.rows.push({
      id: 'sweep-t2',
      tenantId: 't2',
      trigger: 'full_sweep',
      status: 'success',
      startedAt: new Date('2026-10-05T18:50:00.000Z'),
      finishedAt: new Date('2026-10-05T19:00:00.000Z'),
    });
    const status = await svc.status('t1', readGithubAuditConfig({}), NOW);
    expect(status.lastFullSweep).toBeNull();
  });
});

describe('GithubAuditSyncService.coverageForDay (digest seal)', () => {
  const DAY = '2026-10-05';
  // istDayEnd('2026-10-05') = 2026-10-05T18:29:59.999Z; overlap defaults to 15.
  const DAY_START = new Date('2026-10-04T18:30:00.000Z');
  const DAY_END = new Date('2026-10-05T18:29:59.999Z');
  const MUST_REACH = new Date(DAY_END.getTime() + 15 * 60_000);
  const RANGE_UPPER = new Date(MUST_REACH.getTime() + 60 * 60_000);
  const INGEST = readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'ingest' });
  const NO_SWEEP = readGithubAuditConfig({
    GITHUB_AUDIT_SYNC_MODE: 'ingest',
    GITHUB_AUDIT_FULL_SWEEP_MINUTES: '0',
  });
  const SWEEP_REASON =
    'no successful full branch sweep has started since 2026-10-05 ended';

  /** A tenant the audit route fully vouches for on DAY. */
  function covered(prisma: ReturnType<typeof fakePrisma>, tenantId: string) {
    seedTenant(prisma, tenantId, ['acme/ehr']);
    prisma.githubAuditCheckpoint.rows.push({
      id: `cp-${tenantId}`,
      tenantId,
      organization: 'acme',
      seededAt: new Date('2026-10-01T00:00:00.000Z'),
      checkpointAt: new Date('2026-10-06T04:00:00.000Z'),
    });
    prisma.githubAuditRun.rows.push({
      id: `sweep-${tenantId}`,
      tenantId,
      mode: 'ingest',
      trigger: 'full_sweep',
      status: 'success',
      startedAt: new Date('2026-10-05T18:50:00.000Z'),
      finishedAt: new Date('2026-10-05T19:00:00.000Z'),
    });
  }

  /** "Now" for the digest run reporting DAY: the next IST morning. */
  const DIGEST_NOW = new Date('2026-10-06T05:00:00.000Z');

  const range = (
    id: string,
    tenantId: string,
    status: string,
    createdAt: Date,
    repo = 'acme/ehr',
    ref = 'main',
  ) => ({ id, tenantId, status, createdAt, repoFullName: repo, ref });

  it('does not apply in shadow mode', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    expect(await svc.coverageForDay('t1', DAY, SHADOW)).toEqual({
      applies: false,
      ok: true,
      reasons: [],
    });
  });

  it('does not apply when no audit-log token ref is configured', async () => {
    const { svc, prisma, secrets } = setup();
    seedTenant(prisma, 't1', ['acme/ehr'], {});
    expect(await svc.coverageForDay('t1', DAY, INGEST)).toEqual({
      applies: false,
      ok: true,
      reasons: [],
    });
    expect(secrets.resolve).not.toHaveBeenCalled();
  });

  it('does not apply when the GitHub configuration is not active', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    prisma.tenantConfiguration.rows[0].status = 'draft';
    expect((await svc.coverageForDay('t1', DAY, INGEST)).applies).toBe(false);
  });

  it('is ok when checkpoint, ranges and the sweep all cover the day — and never resolves a secret or calls GitHub', async () => {
    const { svc, prisma, secrets, audit, client } = setup();
    covered(prisma, 't1');
    expect(await svc.coverageForDay('t1', DAY, INGEST)).toEqual({
      applies: true,
      ok: true,
      reasons: [],
    });
    expect(secrets.resolve).not.toHaveBeenCalled();
    expect(audit.listGitPushes).not.toHaveBeenCalled();
    expect(client.listHeadRefs).not.toHaveBeenCalled();
  });

  it('is not ok before the seeding pass has completed', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    prisma.githubAuditCheckpoint.rows[0].seededAt = null;
    const c = await svc.coverageForDay('t1', DAY, INGEST);
    expect(c.applies).toBe(true);
    expect(c.ok).toBe(false);
    expect(c.reasons).toEqual([
      'audit sync has not completed its seeding pass',
    ]);
  });

  it('is not ok with no checkpoint row at all', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    prisma.githubAuditCheckpoint.rows.length = 0;
    const c = await svc.coverageForDay('t1', DAY, INGEST);
    expect(c.ok).toBe(false);
    expect(c.reasons).toEqual([
      'audit sync has not completed its seeding pass',
      'audit log never read',
    ]);
  });

  it('is not ok when the checkpoint stops short of day end + overlap', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    const short = new Date(MUST_REACH.getTime() - 1);
    prisma.githubAuditCheckpoint.rows[0].checkpointAt = short;
    const c = await svc.coverageForDay('t1', DAY, INGEST);
    expect(c.ok).toBe(false);
    expect(c.reasons).toEqual([
      `audit log read only through ${short.toISOString()}`,
    ]);
  });

  it('is ok with the checkpoint exactly at day end + overlap', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    prisma.githubAuditCheckpoint.rows[0].checkpointAt = MUST_REACH;
    expect((await svc.coverageForDay('t1', DAY, INGEST)).ok).toBe(true);
  });

  it('is not ok with a pending or failed range created on or after day start; finished ranges and ranges before day start are ignored', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    prisma.githubPushRange.rows.push(
      range('in-1', 't1', 'pending', DAY_START, 'acme/ehr', 'main'),
      range('in-2', 't1', 'failed', RANGE_UPPER, 'acme/lab', 'dev'),
      range('done', 't1', 'done', DAY_END),
      range('before', 't1', 'pending', new Date(DAY_START.getTime() - 1)),
    );
    const c = await svc.coverageForDay('t1', DAY, INGEST, DIGEST_NOW);
    expect(c.ok).toBe(false);
    expect(c.reasons).toEqual([
      '2 unfinished range(s): acme/ehr@main, acme/lab@dev',
    ]);
  });

  it('is not ok while a range from the day is truncated, and ok once an admin dismisses it', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    const r = {
      ...range('tr', 't1', 'done', DAY_END, 'acme/ehr', 'big'),
      truncated: true,
    };
    prisma.githubPushRange.rows.push(r);
    const c = await svc.coverageForDay('t1', DAY, INGEST, DIGEST_NOW);
    expect(c.ok).toBe(false);
    expect(c.reasons.join(' ')).toMatch(/1 truncated range/);
    r.status = 'dismissed';
    expect((await svc.coverageForDay('t1', DAY, INGEST, DIGEST_NOW)).ok).toBe(
      true,
    );
  });

  it('ignores a dismissed range that would otherwise be unfinished', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    prisma.githubPushRange.rows.push(
      range('gone', 't1', 'dismissed', DAY_END, 'acme/ehr', 'deleted'),
    );
    expect((await svc.coverageForDay('t1', DAY, INGEST, DIGEST_NOW)).ok).toBe(
      true,
    );
  });

  it('is not ok with a shadowed range from the day still inside the replay window (ingest will replay it)', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    prisma.githubPushRange.rows.push(
      range('sh', 't1', 'shadowed', DAY_END, 'acme/ehr', 'feat'),
    );
    const c = await svc.coverageForDay('t1', DAY, INGEST, DIGEST_NOW);
    expect(c.ok).toBe(false);
    expect(c.reasons).toEqual(['1 unfinished range(s): acme/ehr@feat']);
  });

  it('ignores a shadowed range older than the replay window (ingest will never replay it)', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    prisma.githubPushRange.rows.push(
      range('sh', 't1', 'shadowed', DAY_END, 'acme/ehr', 'feat'),
    );
    // Asked 7 days and a minute after the range was created.
    const later = new Date(DAY_END.getTime() + SHADOW_REPLAY_MS + 60_000);
    const c = await svc.coverageForDay('t1', DAY, INGEST, later);
    expect(c.ok).toBe(true);
  });

  it('ignores a shadowed range created before day start', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    prisma.githubPushRange.rows.push(
      range('sh', 't1', 'shadowed', new Date(DAY_START.getTime() - 1)),
    );
    expect((await svc.coverageForDay('t1', DAY, INGEST, DIGEST_NOW)).ok).toBe(
      true,
    );
  });

  it('is not ok when the only successful sweep after the day ran in shadow mode', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    prisma.githubAuditRun.rows[0].mode = 'shadow';
    const c = await svc.coverageForDay('t1', DAY, INGEST, DIGEST_NOW);
    expect(c.ok).toBe(false);
    expect(c.reasons).toEqual([SWEEP_REASON]);
  });

  it('has no upper bound on the unfinished-range window: a range created well after the old window (day end + 3h) still counts', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    // An audit catch-up after a stall, or a late sweep that plans a missed
    // push and stops on budget, can create the day's ranges long after the
    // old fixed upper bound (dayEnd + overlap + 60min) — the pusher must
    // still be withheld, not silently cleared past that point.
    const late = new Date(DAY_END.getTime() + 3 * 3_600_000);
    prisma.githubPushRange.rows.push(range('late', 't1', 'pending', late));
    const c = await svc.coverageForDay('t1', DAY, INGEST);
    expect(c.ok).toBe(false);
    expect(c.reasons).toEqual(['1 unfinished range(s): acme/ehr@main']);
  });

  it('ignores a range created before day start', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    prisma.githubPushRange.rows.push(
      range('before', 't1', 'pending', new Date(DAY_START.getTime() - 1)),
    );
    expect((await svc.coverageForDay('t1', DAY, INGEST)).ok).toBe(true);
  });

  it('names at most 5 unfinished ranges and counts the rest, with bounded reads', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    for (let i = 0; i < 7; i++) {
      prisma.githubPushRange.rows.push(
        range(
          `r${i}`,
          't1',
          'pending',
          new Date(DAY_START.getTime() + i * 60_000),
          `acme/r${i}`,
          'main',
        ),
      );
    }
    const c = await svc.coverageForDay('t1', DAY, INGEST);
    expect(c.reasons).toEqual([
      '7 unfinished range(s): acme/r0@main, acme/r1@main, acme/r2@main, acme/r3@main, acme/r4@main (and 2 more)',
    ]);
    // A count plus at most 5 rows — never the whole queue.
    expect(prisma.githubPushRange.findMany.mock.calls[0][0]?.take).toBe(5);
    expect(prisma.githubPushRange.count).toHaveBeenCalled();
  });

  it('is not ok when no full sweep has run', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    prisma.githubAuditRun.rows.length = 0;
    const c = await svc.coverageForDay('t1', DAY, INGEST);
    expect(c.ok).toBe(false);
    expect(c.reasons).toEqual([SWEEP_REASON]);
  });

  it.each([
    ['failed', { status: 'failed' }],
    ['partial', { status: 'partial' }],
    [
      'started before the day ended and only finished after',
      { startedAt: DAY_START, finishedAt: new Date(DAY_END.getTime() + 1) },
    ],
    ['started at the last instant of the day', { startedAt: DAY_END }],
    ['an audit run, not a sweep', { trigger: 'audit' }],
    [
      'still running',
      { status: 'running', startedAt: DAY_START, finishedAt: null },
    ],
  ])(
    'is not ok when the only sweep is %s',
    async (_label: string, patch: Record<string, unknown>) => {
      const { svc, prisma } = setup();
      covered(prisma, 't1');
      Object.assign(prisma.githubAuditRun.rows[0], patch);
      const c = await svc.coverageForDay('t1', DAY, INGEST);
      expect(c.ok).toBe(false);
      expect(c.reasons).toEqual([SWEEP_REASON]);
    },
  );

  it('is ok when the sweep started just after the day ended', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    Object.assign(prisma.githubAuditRun.rows[0], {
      startedAt: new Date(DAY_END.getTime() + 1),
      finishedAt: new Date(DAY_END.getTime() + 2),
      status: 'success',
    });
    expect((await svc.coverageForDay('t1', DAY, INGEST)).ok).toBe(true);
  });

  it('skips the sweep condition when the sweep is disabled (0)', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    prisma.githubAuditRun.rows.length = 0;
    expect(await svc.coverageForDay('t1', DAY, NO_SWEEP)).toEqual({
      applies: true,
      ok: true,
      reasons: [],
    });
    expect(prisma.githubAuditRun.findFirst).not.toHaveBeenCalled();
  });

  it('reports every failing condition together', async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    prisma.githubAuditCheckpoint.rows[0].checkpointAt = DAY_END;
    prisma.githubAuditRun.rows.length = 0;
    prisma.githubPushRange.rows.push(range('r', 't1', 'pending', DAY_END));
    const c = await svc.coverageForDay('t1', DAY, INGEST);
    expect(c.reasons).toEqual([
      `audit log read only through ${DAY_END.toISOString()}`,
      '1 unfinished range(s): acme/ehr@main',
      SWEEP_REASON,
    ]);
  });

  it("never lets another tenant's checkpoint, ranges or sweep affect the result (tenant isolation)", async () => {
    const { svc, prisma } = setup();
    covered(prisma, 't1');
    covered(prisma, 't2');
    // t1 has no sweep; t2's must not stand in for it.
    prisma.githubAuditRun.rows.splice(0, 1);
    // t2's unfinished range in the window must not count against t1.
    prisma.githubPushRange.rows.push(
      range('t2-r', 't2', 'pending', DAY_END, 'other/ehr', 'main'),
    );
    // t1 not seeded; t2's seeded checkpoint must not stand in for it.
    prisma.githubAuditCheckpoint.rows[0].seededAt = null;
    prisma.calls.length = 0;
    const c = await svc.coverageForDay('t1', DAY, INGEST);
    expect(c.reasons).toEqual([
      'audit sync has not completed its seeding pass',
      SWEEP_REASON,
    ]);
    expect(prisma.calls.length).toBeGreaterThan(0);
    for (const call of prisma.calls) {
      const where = call.where as {
        tenantId?: string;
        tenantId_namespace_key?: { tenantId: string };
      };
      expect(where.tenantId ?? where.tenantId_namespace_key?.tenantId).toBe(
        't1',
      );
    }
    // And t2 sees its own range, not t1's state.
    const c2 = await svc.coverageForDay('t2', DAY, INGEST);
    expect(c2.reasons).toEqual(['1 unfinished range(s): other/ehr@main']);
  });
});

describe('GithubAuditSyncService.runFullSweep (full branch sweep)', () => {
  const noCommits = { commits: [], pages: 1, truncated: false };

  it('plans a range for a moved branch in a repo the audit log never reported, then executes it', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/amma']);
    seeded(prisma, 't1', {
      'acme/ehr': { master: 'm1', 'feature-A': 'A' },
      'acme/amma': { master: 'm2' },
    });
    client.listHeadRefs.mockImplementation(async (repo: string) =>
      repo === 'acme/ehr'
        ? {
            tips: new Map([
              ['master', 'm1'],
              ['feature-A', 'B'],
            ]),
          }
        : { tips: new Map([['master', 'm2']]) },
    );
    client.compareAll.mockResolvedValue(noCommits);
    const r = await svc.runFullSweep('t1', SHADOW, NOW);

    expect(r.status).toBe('success');
    expect(r.counters).toMatchObject({
      reposTouched: 2,
      refsMoved: 1,
      compareRequestsPlanned: 1,
      compareRequestsExecuted: 1,
      compareCandidatesNaive: 0,
    });
    expect(prisma.githubPushRange.rows).toHaveLength(1);
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      repoFullName: 'acme/ehr',
      ref: 'feature-A',
      baseSha: 'A',
      headSha: 'B',
      kind: 'moved',
      auditDocumentIds: [],
      status: 'shadowed',
      runId: r.runId,
    });
    expect(client.compareAll).toHaveBeenCalledWith(
      'acme/ehr',
      'tok:GITHUB_TOKEN',
      'A',
      'B',
    );
    expect(
      prisma.githubRefTip.rows.find(
        (t) => t.repoFullName === 'acme/ehr' && t.ref === 'feature-A',
      )!.sha,
    ).toBe('B');
    expect(audit.listGitPushes).not.toHaveBeenCalled();
  });

  it('never calls the audit client and never moves checkpointAt or seededAt', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    const { checkpointAt, seededAt } = prisma.githubAuditCheckpoint.rows[0];
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([
        ['master', 'm1'],
        ['feature-new', 'N'],
      ]),
    });
    client.compareAll.mockResolvedValue(noCommits);
    await svc.runFullSweep('t1', SHADOW, NOW);
    expect(audit.listGitPushes).not.toHaveBeenCalled();
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toBe(
      checkpointAt,
    );
    expect(prisma.githubAuditCheckpoint.rows[0].seededAt).toBe(seededAt);
    const writes = prisma.calls.flatMap((c) => [c.data ?? {}, c.update ?? {}]);
    expect(writes.some((d) => 'checkpointAt' in d || 'seededAt' in d)).toBe(
      false,
    );
  });

  it('writes a run row with trigger full_sweep (and audit runs write trigger audit)', async () => {
    const { svc, prisma, audit, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([['master', 'm1']]),
    });
    audit.listGitPushes.mockResolvedValue({
      status: 'complete',
      events: [],
      pages: 1,
      nextTraversals: 0,
    });
    const sweep = await svc.runFullSweep('t1', SHADOW, NOW);
    const auditRun = await svc.runTenant('t1', SHADOW, NOW);
    const byId = (id?: string) =>
      prisma.githubAuditRun.rows.find((x) => x.id === id)!;
    expect(byId(sweep.runId)).toMatchObject({
      trigger: 'full_sweep',
      status: 'success',
      windowFrom: null,
      windowTo: null,
    });
    expect(byId(auditRun.runId).trigger).toBe('audit');
  });

  it('skips, without a run row or any GitHub call, while another run holds the claim', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    const held = new Date(NOW.getTime() - 5 * 60_000);
    prisma.githubAuditCheckpoint.rows[0].runningSince = held;
    const r = await svc.runFullSweep('t1', SHADOW, NOW);
    expect(r).toMatchObject({
      status: 'skipped',
      reason: 'Another audit sync run for this tenant is in progress.',
    });
    expect(prisma.githubAuditRun.rows).toHaveLength(0);
    expect(client.listHeadRefs).not.toHaveBeenCalled();
    expect(prisma.githubAuditCheckpoint.rows[0].runningSince).toBe(held);
  });

  it('releases its claim even when the sweep fails', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    client.listHeadRefs.mockRejectedValue(new Error('boom'));
    const r = await svc.runFullSweep('t1', SHADOW, NOW);
    expect(r.status).toBe('failed');
    expect(
      prisma.githubAuditCheckpoint.rows[0].runningSince ?? null,
    ).toBeNull();
    expect(prisma.githubAuditRun.rows[0]).toMatchObject({
      trigger: 'full_sweep',
      status: 'failed',
    });
  });

  it('does nothing until the audit sync has seeded the tenant', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    const r = await svc.runFullSweep('t1', SHADOW, NOW);
    expect(r).toMatchObject({
      status: 'skipped',
      reason: 'not seeded yet — the audit sync seeds first',
    });
    expect(client.getDefaultBranch).not.toHaveBeenCalled();
    expect(client.listHeadRefs).not.toHaveBeenCalled();
    expect(prisma.githubAuditRun.rows).toHaveLength(0);
  });

  it('skips when the mode is off or no audit-log token ref is configured', async () => {
    const off = setup();
    seedTenant(off.prisma, 't1', ['acme/ehr']);
    seeded(off.prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    const r1 = await off.svc.runFullSweep('t1', readGithubAuditConfig({}), NOW);
    expect(r1.status).toBe('skipped');
    expect(off.client.listHeadRefs).not.toHaveBeenCalled();

    const noRef = setup();
    seedTenant(noRef.prisma, 't1', ['acme/ehr'], {});
    seeded(noRef.prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    const r2 = await noRef.svc.runFullSweep('t1', SHADOW, NOW);
    expect(r2.status).toBe('skipped');
    expect(r2.reason).toMatch(/audit-log token/i);
    expect(noRef.client.listHeadRefs).not.toHaveBeenCalled();
  });

  it('seeds a registered repo that has never been seeded, planning no range for it', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr', 'acme/new']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([
        ['master', 'm1'],
        ['feat', 'f1'],
      ]),
    });
    client.compareAll.mockResolvedValue(noCommits);
    const r = await svc.runFullSweep('t1', SHADOW, NOW);
    expect(r.counters.reposSeeded).toBe(1);
    expect(
      prisma.githubRefTip.rows
        .filter((t) => t.repoFullName === 'acme/new')
        .map((t) => t.ref)
        .sort(),
    ).toEqual(['HEAD', 'feat', 'master']);
    expect(
      prisma.githubPushRange.rows.filter((x) => x.repoFullName === 'acme/new'),
    ).toHaveLength(0);
  });

  it('stops at the core budget: the remaining repos are left unplanned and named in run.error', async () => {
    const { svc, prisma, client } = setup();
    const originalReserve = process.env.GITHUB_BACKFILL_RATE_RESERVE;
    process.env.GITHUB_BACKFILL_RATE_RESERVE = '1000';
    try {
      seedTenant(prisma, 't1', ['acme/a', 'acme/b', 'acme/c']);
      seeded(prisma, 't1', {
        'acme/a': { feat: 'a0' },
        'acme/b': { feat: 'b0' },
        'acme/c': { feat: 'c0' },
      });
      const { checkpointAt } = prisma.githubAuditCheckpoint.rows[0];
      client.listHeadRefs.mockImplementation(async (repo: string) => ({
        tips: new Map([['feat', `${repo}-moved`]]),
        rateLimit: { remaining: 1000, resetAt: NOW },
      }));
      const cfg = readGithubAuditConfig({
        GITHUB_AUDIT_SYNC_MODE: 'shadow',
        GITHUB_AUDIT_COMPARE_CONCURRENCY: '1',
      });
      const r = await svc.runFullSweep('t1', cfg, NOW);
      expect(client.listHeadRefs).toHaveBeenCalledTimes(1);
      expect(r.status).toBe('partial');
      expect(r.counters.reposTouched).toBe(1);
      const error = prisma.githubAuditRun.rows[0].error as string;
      expect(error).toMatch(/2 repo\(s\).*reserve/i);
      expect(error).toContain('acme/b');
      expect(error).toContain('acme/c');
      // Unplanned repos keep their old tips, so the next sweep still sees the move.
      expect(
        prisma.githubRefTip.rows.find(
          (t) => t.repoFullName === 'acme/b' && t.ref === 'feat',
        )!.sha,
      ).toBe('b0');
      expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toBe(
        checkpointAt,
      );
    } finally {
      if (originalReserve === undefined) {
        delete process.env.GITHUB_BACKFILL_RATE_RESERVE;
      } else {
        process.env.GITHUB_BACKFILL_RATE_RESERVE = originalReserve;
      }
    }
  });

  it.each(['not_found', 'forbidden'])(
    'fails under an org-wide refusal (every repo answers %s) and does not satisfy the digest gate',
    async (failure) => {
      const { svc, prisma, client } = setup();
      seedTenant(prisma, 't1', ['acme/a', 'acme/b', 'acme/c']);
      seeded(prisma, 't1', {
        'acme/a': { feat: 'a0' },
        'acme/b': { feat: 'b0' },
        'acme/c': { feat: 'c0' },
      });
      client.listHeadRefs.mockResolvedValue({ failure });
      // A range queued earlier is not executed under a refused token — that
      // would only burn its attempts.
      prisma.githubPushRange.rows.push({
        id: 'queued',
        tenantId: 't1',
        status: 'pending',
        repoFullName: 'acme/a',
        ref: 'feat',
        baseSha: 'a0',
        headSha: 'a1',
        kind: 'moved',
        attempts: 0,
        createdAt: new Date('2026-10-04T12:00:00.000Z'),
      });
      const INGEST = readGithubAuditConfig({
        GITHUB_AUDIT_SYNC_MODE: 'ingest',
      });
      // A sweep that starts after 2026-10-05 (IST) has ended.
      const sweepAt = new Date('2026-10-05T19:00:00.000Z');
      const r = await svc.runFullSweep('t1', INGEST, sweepAt);
      expect(r.status).toBe('failed');
      expect(r.reason).toContain(
        'collector token refused (403/404) for 3 of 3 repos — check token scope, SSO authorization and that these repos still exist',
      );
      expect(prisma.githubAuditRun.rows[0]).toMatchObject({
        trigger: 'full_sweep',
        mode: 'ingest',
        status: 'failed',
      });
      expect(client.compareAll).not.toHaveBeenCalled();
      expect(prisma.githubPushRange.rows[0].attempts).toBe(0);
      // Everything else the gate checks is satisfied (the queued range was
      // created before the day started), so only the sweep fails it.
      prisma.githubAuditCheckpoint.rows[0].checkpointAt = new Date(
        '2026-10-06T04:00:00.000Z',
      );
      const c = await svc.coverageForDay(
        't1',
        '2026-10-05',
        INGEST,
        new Date('2026-10-06T05:00:00.000Z'),
      );
      expect(c.ok).toBe(false);
      expect(c.reasons).toEqual([
        'no successful full branch sweep has started since 2026-10-05 ended',
      ]);
    },
  );

  it('is partial, not success, when a repo listing fails without throwing', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/a', 'acme/b']);
    seeded(prisma, 't1', {
      'acme/a': { feat: 'a0' },
      'acme/b': { feat: 'b0' },
    });
    client.listHeadRefs.mockImplementation(async (repo: string) =>
      repo === 'acme/a'
        ? { tips: new Map([['feat', 'a0']]) }
        : { failure: 'failed' },
    );
    const r = await svc.runFullSweep('t1', SHADOW, NOW);
    expect(r.status).toBe('partial');
    expect(r.reason).toMatch(
      /Could not list branches for 1 repo\(s\): acme\/b: failed/,
    );
    expect(prisma.githubAuditRun.rows[0].status).toBe('partial');
  });

  it('reads and writes only the requested tenant (tenant isolation)', async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['acme/ehr']);
    seedTenant(prisma, 't2', ['other/ehr']);
    seeded(prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    seeded(prisma, 't2', { 'other/ehr': { master: 'z1' } });
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([['master', 'm1']]),
    });
    await svc.runFullSweep('t1', SHADOW, NOW);
    expect(client.listHeadRefs.mock.calls.map((c) => c[0])).toEqual([
      'acme/ehr',
    ]);
    const tenantIds = prisma.calls
      .flatMap((c) => [c.where, c.data, c.create])
      .map((x) => x?.tenantId)
      .filter((t) => t !== undefined);
    expect(tenantIds.length).toBeGreaterThan(0);
    expect(new Set(tenantIds)).toEqual(new Set(['t1']));
  });
});

describe('GithubAuditSyncService.runTenant (auto-registering unregistered repos)', () => {
  const INGEST = readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'ingest' });
  const noCommits = { commits: [], pages: 1, truncated: false };
  const auditOf = (...events: ReturnType<typeof push>[]) => ({
    status: 'complete',
    pages: 1,
    nextTraversals: 0,
    events,
  });

  /** t1 with acme/ehr registered and seeded; `acme/fresh` has no connection. */
  function fresh() {
    const s = setup();
    seedTenant(s.prisma, 't1', ['acme/ehr']);
    seeded(s.prisma, 't1', { 'acme/ehr': { master: 'm1' } });
    s.client.compareAll.mockResolvedValue(noCommits);
    return s;
  }

  it('registers a pushed repo with no connection in the org-sync shape, seeds it and plans new_ref ranges for its non-default branches', async () => {
    const { svc, prisma, audit, client, connections, auditSink, ingestion } =
      fresh();
    prisma.tenantConfiguration.rows[0].values.backfillDays = 30;
    audit.listGitPushes.mockResolvedValue(
      auditOf(push('e1', 'acme/fresh'), push('e2', 'acme/fresh')),
    );
    client.getDefaultBranch.mockResolvedValue({
      name: 'main',
      archived: false,
      disabled: false,
    });
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([
        ['main', 'n1'],
        ['feat-a', 'a1'],
        ['feat-b', 'b1'],
      ]),
    });

    const r = await svc.runTenant('t1', INGEST, NOW);

    expect(r.status).toBe('success');
    expect(r.counters).toMatchObject({
      reposRegistered: 1,
      reposUnregistered: 0,
      reposUnseedable: 0,
      refsNew: 2,
      compareRequestsPlanned: 2,
    });
    expect(connections.create).toHaveBeenCalledTimes(1);
    expect(connections.create).toHaveBeenCalledWith('t1', {
      sourceSystem: 'github',
      name: 'acme/fresh',
      config: {
        repoFullName: 'acme/fresh',
        backfillSince: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
      },
      secretRef: 'GITHUB_TOKEN',
    });
    // The collector token from the new connection's ref — never the audit token.
    for (const fn of [client.getDefaultBranch, client.listHeadRefs]) {
      for (const call of fn.mock.calls) {
        expect(call[1]).toBe('tok:GITHUB_TOKEN');
      }
    }
    expect(
      prisma.githubRefTip.rows
        .filter((t) => t.repoFullName === 'acme/fresh')
        .map((t) => `${t.ref}=${t.sha}`)
        .sort(),
    ).toEqual(['HEAD=main', 'feat-a=a1', 'feat-b=b1', 'main=n1']);
    const ranges = prisma.githubPushRange.rows.filter(
      (x) => x.repoFullName === 'acme/fresh',
    );
    expect(
      ranges.map((x) => `${x.ref}:${x.baseRef}...${x.headSha}`).sort(),
    ).toEqual(['feat-a:main...a1', 'feat-b:main...b1']);
    for (const x of ranges) {
      expect(x).toMatchObject({
        kind: 'new_ref',
        baseSha: null,
        connectionId: 'new-acme/fresh',
        auditDocumentIds: ['e1', 'e2'],
        runId: r.runId,
      });
    }
    // Executed in the same run, against the new connection.
    expect(client.compareAll).toHaveBeenCalledWith(
      'acme/fresh',
      'tok:GITHUB_TOKEN',
      'main',
      'a1',
    );
    // The push evidence is stored against the new connection too.
    const pushEnvelopes = ingestion.ingest.mock.calls
      .map((c) => c[1])
      .filter((e) => e.idempotencyKey.startsWith('github:audit:'));
    expect(pushEnvelopes.map((e) => e.connectionId)).toEqual([
      'new-acme/fresh',
      'new-acme/fresh',
    ]);
    expect(auditSink.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        actorType: 'system',
        action: 'connection.auto_registered',
        targetType: 'connection',
        targetId: 'new-acme/fresh',
      }),
    );
    expect(JSON.stringify(auditSink.record.mock.calls)).not.toContain('tok:');
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(NOW);
  });

  it('defaults backfillSince to 90 days when the GitHub configuration sets no backfillDays', async () => {
    const { svc, audit, client, connections } = fresh();
    audit.listGitPushes.mockResolvedValue(auditOf(push('e1', 'acme/fresh')));
    client.getDefaultBranch.mockResolvedValue({ name: 'main' });
    client.listHeadRefs.mockResolvedValue({ tips: new Map([['main', 'n1']]) });
    await svc.runTenant('t1', INGEST, NOW);
    expect(connections.create.mock.calls[0][1].config).toEqual({
      repoFullName: 'acme/fresh',
      backfillSince: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
    });
  });

  it('registers it only once: the next run treats it as an ordinary registered repo', async () => {
    const { svc, audit, client, connections } = fresh();
    audit.listGitPushes.mockResolvedValue(auditOf(push('e1', 'acme/fresh')));
    client.getDefaultBranch.mockResolvedValue({ name: 'main' });
    client.listHeadRefs.mockResolvedValue({ tips: new Map([['main', 'n1']]) });
    await svc.runTenant('t1', INGEST, NOW);
    const second = await svc.runTenant(
      't1',
      INGEST,
      new Date(NOW.getTime() + 300_000),
    );
    expect(connections.create).toHaveBeenCalledTimes(1);
    expect(second.counters.reposRegistered).toBe(0);
    expect(second.counters.reposTouched).toBe(1);
  });

  it.each([
    ['archived', { name: 'main', archived: true }],
    ['disabled', { name: 'main', disabled: true }],
  ])(
    'skips an %s repo: no connection, counted as unregistered, checkpoint advances',
    async (_label, branch) => {
      const { svc, prisma, audit, client, connections } = fresh();
      audit.listGitPushes.mockResolvedValue(auditOf(push('e1', 'acme/fresh')));
      client.getDefaultBranch.mockResolvedValue(branch);
      const r = await svc.runTenant('t1', INGEST, NOW);
      expect(r.status).toBe('success');
      expect(r.counters).toMatchObject({
        reposRegistered: 0,
        reposUnregistered: 1,
      });
      expect(connections.create).not.toHaveBeenCalled();
      expect(client.listHeadRefs).not.toHaveBeenCalled();
      expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(NOW);
    },
  );

  it.each(['not_found', 'forbidden'])(
    'skips a repo GitHub answers %s for: no connection, counted and named as unseedable, checkpoint advances',
    async (failure) => {
      const { svc, prisma, audit, client, connections } = fresh();
      audit.listGitPushes.mockResolvedValue(auditOf(push('e1', 'acme/fresh')));
      client.getDefaultBranch.mockResolvedValue({ failure });
      const r = await svc.runTenant('t1', INGEST, NOW);
      expect(r.status).toBe('success');
      expect(r.counters).toMatchObject({
        reposRegistered: 0,
        reposUnseedable: 1,
      });
      expect(connections.create).not.toHaveBeenCalled();
      expect(prisma.githubAuditRun.rows[0].error).toContain('acme/fresh');
      expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(NOW);
    },
  );

  it('leaves an existing disabled connection alone: no GitHub call, no new connection, counted as unregistered', async () => {
    const { svc, prisma, audit, client, connections } = fresh();
    prisma.connection.rows.push({
      id: 't1-conn-off',
      tenantId: 't1',
      sourceSystem: 'github',
      status: 'disabled',
      name: 'acme/fresh',
      secretRef: 'GITHUB_TOKEN',
      config: { repoFullName: 'acme/fresh' },
    });
    audit.listGitPushes.mockResolvedValue(auditOf(push('e1', 'acme/fresh')));
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(r.status).toBe('success');
    expect(r.counters).toMatchObject({
      reposRegistered: 0,
      reposUnregistered: 1,
    });
    expect(connections.create).not.toHaveBeenCalled();
    expect(client.getDefaultBranch).not.toHaveBeenCalled();
    expect(prisma.connection.rows.find((c) => c.id === 't1-conn-off')).toEqual(
      expect.objectContaining({ status: 'disabled' }),
    );
  });

  it('leaves alone a non-active connection for the repo even when it is named differently', async () => {
    const { svc, prisma, audit, client, connections } = fresh();
    prisma.connection.rows.push({
      id: 't1-bridge',
      tenantId: 't1',
      sourceSystem: 'github',
      status: 'disabled',
      name: 'github-default',
      secretRef: 'GITHUB_TOKEN',
      config: { repoFullName: 'acme/fresh' },
    });
    audit.listGitPushes.mockResolvedValue(auditOf(push('e1', 'acme/fresh')));
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(r.counters.reposUnregistered).toBe(1);
    expect(connections.create).not.toHaveBeenCalled();
    expect(client.getDefaultBranch).not.toHaveBeenCalled();
  });

  it('above GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES: seeds only, plans no range, and names the repo in run.error', async () => {
    const { svc, prisma, audit, client } = fresh();
    audit.listGitPushes.mockResolvedValue(auditOf(push('e1', 'acme/fresh')));
    client.getDefaultBranch.mockResolvedValue({ name: 'main' });
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([
        ['main', 'n1'],
        ['feat-a', 'a1'],
        ['feat-b', 'b1'],
      ]),
    });
    const cfg = readGithubAuditConfig({
      GITHUB_AUDIT_SYNC_MODE: 'ingest',
      GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES: '2',
    });
    const r = await svc.runTenant('t1', cfg, NOW);
    expect(r.status).toBe('success');
    expect(r.counters).toMatchObject({ reposRegistered: 1, refsNew: 0 });
    expect(prisma.githubPushRange.rows).toHaveLength(0);
    expect(
      prisma.githubRefTip.rows
        .filter((t) => t.repoFullName === 'acme/fresh')
        .map((t) => t.ref)
        .sort(),
    ).toEqual(['HEAD', 'feat-a', 'feat-b', 'main']);
    const error = prisma.githubAuditRun.rows[0].error as string;
    expect(error).toContain('acme/fresh');
    expect(error).toContain('GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES');
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(NOW);
  });

  it('at exactly the cap, still plans the ranges', async () => {
    const { svc, prisma, audit, client } = fresh();
    audit.listGitPushes.mockResolvedValue(auditOf(push('e1', 'acme/fresh')));
    client.getDefaultBranch.mockResolvedValue({ name: 'main' });
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([
        ['main', 'n1'],
        ['feat-a', 'a1'],
      ]),
    });
    const cfg = readGithubAuditConfig({
      GITHUB_AUDIT_SYNC_MODE: 'ingest',
      GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES: '2',
    });
    const r = await svc.runTenant('t1', cfg, NOW);
    expect(r.counters.refsNew).toBe(1);
    expect(prisma.githubPushRange.rows).toHaveLength(1);
  });

  it('holds the checkpoint, creating no connection, when the default-branch read fails transiently', async () => {
    const { svc, prisma, audit, client, connections } = fresh();
    const before = prisma.githubAuditCheckpoint.rows[0].checkpointAt;
    audit.listGitPushes.mockResolvedValue(auditOf(push('e1', 'acme/fresh')));
    client.getDefaultBranch.mockResolvedValue({ failure: 'failed' });
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(r.status).toBe('failed');
    expect(connections.create).not.toHaveBeenCalled();
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(before);
    expect(prisma.githubAuditRun.rows[0].error).toContain('acme/fresh');
  });

  it('holds the checkpoint, creating no connection, when listing its branches fails transiently', async () => {
    const { svc, prisma, audit, client, connections } = fresh();
    const before = prisma.githubAuditCheckpoint.rows[0].checkpointAt;
    audit.listGitPushes.mockResolvedValue(auditOf(push('e1', 'acme/fresh')));
    client.getDefaultBranch.mockResolvedValue({ name: 'main' });
    client.listHeadRefs.mockResolvedValue({ failure: 'failed' });
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(r.status).toBe('failed');
    expect(connections.create).not.toHaveBeenCalled();
    expect(
      prisma.githubRefTip.rows.filter((t) => t.repoFullName === 'acme/fresh'),
    ).toHaveLength(0);
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(before);
  });

  it('does not register a repo once the core budget has reached the reserve; holds the checkpoint with the reason in run.error', async () => {
    const { svc, prisma, audit, client, connections } = fresh();
    const originalReserve = process.env.GITHUB_BACKFILL_RATE_RESERVE;
    process.env.GITHUB_BACKFILL_RATE_RESERVE = '1000';
    try {
      const before = prisma.githubAuditCheckpoint.rows[0].checkpointAt;
      // The registered repo is listed first and spends the budget down to the
      // reserve, so the unregistered one behind it must not be checked at all.
      audit.listGitPushes.mockResolvedValue(
        auditOf(push('e1', 'acme/ehr'), push('e2', 'acme/fresh')),
      );
      client.listHeadRefs.mockResolvedValue({
        tips: new Map([['master', 'm1']]),
        rateLimit: { remaining: 1000, resetAt: NOW },
      });
      const cfg = readGithubAuditConfig({
        GITHUB_AUDIT_SYNC_MODE: 'ingest',
        GITHUB_AUDIT_COMPARE_CONCURRENCY: '1',
      });
      const r = await svc.runTenant('t1', cfg, NOW);
      expect(client.getDefaultBranch).not.toHaveBeenCalled();
      expect(connections.create).not.toHaveBeenCalled();
      expect(r.status).toBe('failed');
      expect(r.counters.reposRegistered).toBe(0);
      const error = prisma.githubAuditRun.rows[0].error as string;
      expect(error).toContain('acme/fresh');
      expect(error).toMatch(/reserve/i);
      expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(before);
    } finally {
      if (originalReserve === undefined) {
        delete process.env.GITHUB_BACKFILL_RATE_RESERVE;
      } else {
        process.env.GITHUB_BACKFILL_RATE_RESERVE = originalReserve;
      }
    }
  });

  it('does not register without a collector tokenRef on the GitHub configuration (never falls back to the audit token)', async () => {
    const { svc, prisma, audit, client, connections } = fresh();
    delete prisma.tenantConfiguration.rows[0].secretRefs.tokenRef;
    audit.listGitPushes.mockResolvedValue(auditOf(push('e1', 'acme/fresh')));
    const r = await svc.runTenant('t1', INGEST, NOW);
    expect(r.counters).toMatchObject({
      reposRegistered: 0,
      reposUnregistered: 1,
    });
    expect(connections.create).not.toHaveBeenCalled();
    expect(client.getDefaultBranch).not.toHaveBeenCalled();
    expect(prisma.githubAuditRun.rows[0].error).toMatch(/tokenRef/);
  });

  it('in shadow mode only reports it: checks GitHub, creates no connection, seeds and plans nothing, advances the checkpoint', async () => {
    const { svc, prisma, audit, client, connections, ingestion, auditSink } =
      fresh();
    audit.listGitPushes.mockResolvedValue(auditOf(push('e1', 'acme/fresh')));
    client.getDefaultBranch.mockResolvedValue({ name: 'main' });
    client.listHeadRefs.mockResolvedValue({
      tips: new Map([
        ['main', 'n1'],
        ['feat-a', 'a1'],
      ]),
    });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.status).toBe('success');
    expect(r.counters).toMatchObject({
      reposWouldRegister: 1,
      reposRegistered: 0,
      reposUnregistered: 0,
    });
    expect(client.getDefaultBranch).toHaveBeenCalledWith(
      'acme/fresh',
      'tok:GITHUB_TOKEN',
    );
    expect(client.listHeadRefs).not.toHaveBeenCalled();
    expect(connections.create).not.toHaveBeenCalled();
    expect(auditSink.record).not.toHaveBeenCalled();
    expect(
      prisma.githubRefTip.rows.filter((t) => t.repoFullName === 'acme/fresh'),
    ).toHaveLength(0);
    expect(prisma.githubPushRange.rows).toHaveLength(0);
    expect(
      ingestion.ingest.mock.calls.filter(
        (c) => c[1].connectionId === undefined,
      ),
    ).toHaveLength(0);
    expect(prisma.githubAuditRun.rows[0].error).toContain(
      'would auto-register (shadow): acme/fresh',
    );
    expect(prisma.githubAuditCheckpoint.rows[0].checkpointAt).toEqual(NOW);
  });

  it('in shadow mode still skips an archived repo without reporting it as would-register', async () => {
    const { svc, audit, client, connections } = fresh();
    audit.listGitPushes.mockResolvedValue(auditOf(push('e1', 'acme/fresh')));
    client.getDefaultBranch.mockResolvedValue({ name: 'main', archived: true });
    const r = await svc.runTenant('t1', SHADOW, NOW);
    expect(r.counters).toMatchObject({
      reposWouldRegister: 0,
      reposUnregistered: 1,
    });
    expect(connections.create).not.toHaveBeenCalled();
  });
});
