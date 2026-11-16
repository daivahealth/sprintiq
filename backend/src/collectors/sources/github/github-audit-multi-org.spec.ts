import { readGithubAuditConfig } from './github-audit.config';
import { GithubAuditSyncService } from './github-audit-sync.service';
import {
  fakeIngestion,
  fakePrisma,
  seedOrg,
  seedTenant,
} from './github-audit-sync.fakes';

const NOW = new Date('2026-10-06T10:00:00Z');
const SHADOW = readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'shadow' });

function setup() {
  const prisma = fakePrisma();
  const ingestion = fakeIngestion(prisma);
  const audit = { listGitPushes: jest.fn() };
  const client = {
    listHeadRefs: jest.fn(),
    getDefaultBranch: jest.fn().mockResolvedValue({ name: 'master' }),
    compareAll: jest.fn(),
    listBranchCommits: jest
      .fn()
      .mockResolvedValue({ commits: [], pages: 1, truncated: false }),
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

const seededAt = new Date(NOW.getTime() - 3_600_000);
const checkpointAt = new Date(NOW.getTime() - 300_000);

describe('GithubAuditSyncService — per organisation (ADR-0013)', () => {
  it('lists one enabled entry per active org with an effective audit ref', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site']); // inherits the audit ref
    seedOrg(prisma, 't1', 'Paused', [], { status: 'disabled' });
    await expect(svc.listEnabledOrgs()).resolves.toEqual([
      { tenantId: 't1', organization: 'athmahealth' },
      { tenantId: 't1', organization: 'NHWebsite' },
    ]);
  });

  it("the default org's sweep never lists another org's repos", async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site']);
    prisma.githubAuditCheckpoint.rows.push({
      id: 'cp1',
      tenantId: 't1',
      organization: 'athmahealth',
      seededAt,
      checkpointAt,
    });
    client.listHeadRefs.mockResolvedValue({ tips: new Map() });

    await svc.runFullSweep('t1', SHADOW, NOW);

    expect(client.listHeadRefs.mock.calls.map((c) => c[0])).toEqual([
      'athmahealth/ehr',
    ]);
    expect(prisma.githubAuditRun.rows.at(-1)?.organization).toBe('athmahealth');
  });

  it("a refused second org fails only its own run; the default org's checkpoint is untouched", async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/a', 'NHWebsite/b'], {
      tokenRef: 'GITHUB_TOKEN_NHWEBSITE',
    });
    prisma.githubAuditCheckpoint.rows.push({
      id: 'cp1',
      tenantId: 't1',
      organization: 'athmahealth',
      seededAt,
      checkpointAt,
    });
    client.getDefaultBranch.mockResolvedValue({ failure: 'not_found' });

    const summary = await svc.runTenant('t1', SHADOW, NOW, 'NHWebsite');

    expect(summary.status).toBe('failed');
    expect(
      prisma.githubAuditCheckpoint.rows.find(
        (r) => r.organization === 'athmahealth',
      ),
    ).toMatchObject({ seededAt, checkpointAt });
    expect(
      prisma.githubAuditCheckpoint.rows.find(
        (r) => r.organization === 'NHWebsite',
      )?.seededAt,
    ).toBeUndefined();
    expect(prisma.githubAuditRun.rows.at(-1)?.organization).toBe('NHWebsite');
  });

  it('the second org reads its own audit log, with the inherited audit token', async () => {
    const { svc, prisma, audit, secrets } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site']);
    prisma.githubAuditCheckpoint.rows.push({
      id: 'cp2',
      tenantId: 't1',
      organization: 'NHWebsite',
      seededAt,
      checkpointAt,
    });
    audit.listGitPushes.mockResolvedValue({
      status: 'complete',
      events: [],
      pages: 1,
      nextTraversals: 0,
    });

    await svc.runTenant('t1', SHADOW, NOW, 'NHWebsite');

    expect(audit.listGitPushes.mock.calls[0][0]).toBe('NHWebsite');
    expect(secrets.resolve).toHaveBeenCalledWith('t1', 'GITHUB_AUDIT_TOKEN');
  });

  it("pending ranges of another org are never executed by this org's run", async () => {
    const { svc, prisma, client } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site']);
    prisma.githubAuditCheckpoint.rows.push({
      id: 'cp1',
      tenantId: 't1',
      organization: 'athmahealth',
      seededAt,
      checkpointAt,
    });
    prisma.githubPushRange.rows.push({
      id: 'r-nh',
      tenantId: 't1',
      connectionId: 't1-nhwebsite-conn-0',
      repoFullName: 'NHWebsite/site',
      ref: 'main',
      kind: 'push',
      status: 'pending',
      attempts: 0,
      createdAt: NOW,
    });
    client.listHeadRefs.mockResolvedValue({ tips: new Map() });

    await svc.runFullSweep('t1', SHADOW, NOW);

    expect(client.compareAll).not.toHaveBeenCalled();
    expect(prisma.githubPushRange.rows[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });

  it('status reports one organisation at a time', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site']);
    prisma.githubPushRange.rows.push(
      {
        id: 'a',
        tenantId: 't1',
        repoFullName: 'athmahealth/ehr',
        status: 'pending',
        createdAt: NOW,
      },
      {
        id: 'b',
        tenantId: 't1',
        repoFullName: 'NHWebsite/site',
        status: 'pending',
        createdAt: NOW,
      },
      {
        id: 'c',
        tenantId: 't1',
        repoFullName: 'NHWebsite/site',
        status: 'failed',
        createdAt: NOW,
      },
    );
    const def = await svc.status('t1', SHADOW, NOW);
    const nh = await svc.status('t1', SHADOW, NOW, 'nhwebsite');
    expect(def).toMatchObject({
      organization: 'athmahealth',
      pendingRanges: 1,
      failedRanges: 0,
    });
    expect(nh).toMatchObject({
      organization: 'NHWebsite',
      pendingRanges: 1,
      failedRanges: 1,
    });
  });
});

const DAY = '2026-10-05';
const INGEST = readGithubAuditConfig({ GITHUB_AUDIT_SYNC_MODE: 'ingest' });

describe('coverageForDay across organisations (ADR-0013)', () => {
  function seededCheckpoint(prisma: ReturnType<typeof setup>['prisma'], organization: string) {
    prisma.githubAuditCheckpoint.rows.push({
      id: `cp-${organization}`, tenantId: 't1', organization,
      seededAt: new Date(NOW.getTime() - 86_400_000 * 3),
      checkpointAt: NOW,
    });
  }
  function sweptAfterDay(prisma: ReturnType<typeof setup>['prisma'], organization: string) {
    prisma.githubAuditRun.rows.push({
      id: `sw-${organization}`, tenantId: 't1', organization, trigger: 'full_sweep',
      status: 'success', mode: 'ingest', startedAt: NOW,
    });
  }

  it('single org: reasons are unprefixed and the org is included', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    const c = await svc.coverageForDay('t1', DAY, INGEST, NOW);
    expect(c.included).toEqual(['athmahealth']);
    expect(c.reasons).toContain('audit sync has not completed its seeding pass');
  });

  it('a second org that has not finished its first seeding + sweep is collecting, not included', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site']);
    seededCheckpoint(prisma, 'athmahealth');
    sweptAfterDay(prisma, 'athmahealth');
    const c = await svc.coverageForDay('t1', DAY, INGEST, NOW);
    expect(c).toMatchObject({ ok: true, included: ['athmahealth'], collecting: ['NHWebsite'] });
  });

  it('once included, an uncovered second org withholds, named in the reason', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site']);
    seededCheckpoint(prisma, 'athmahealth');
    sweptAfterDay(prisma, 'athmahealth');
    seededCheckpoint(prisma, 'NHWebsite');
    // NHWebsite swept successfully once, but long before the day ended.
    prisma.githubAuditRun.rows.push({
      id: 'old', tenantId: 't1', organization: 'NHWebsite', trigger: 'full_sweep',
      status: 'success', mode: 'ingest', startedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const c = await svc.coverageForDay('t1', DAY, INGEST, NOW);
    expect(c.included).toEqual(['athmahealth', 'NHWebsite']);
    expect(c.ok).toBe(false);
    expect(c.reasons.every((r) => r.startsWith('NHWebsite: '))).toBe(true);
  });

  it("a pending range in one org never counts against another org's coverage", async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', ['NHWebsite/site'], { status: 'disabled' });
    seededCheckpoint(prisma, 'athmahealth');
    sweptAfterDay(prisma, 'athmahealth');
    prisma.githubPushRange.rows.push({
      id: 'r', tenantId: 't1', repoFullName: 'NHWebsite/site', ref: 'main',
      status: 'pending', createdAt: NOW,
    });
    const c = await svc.coverageForDay('t1', DAY, INGEST, NOW);
    expect(c).toMatchObject({ ok: true, included: ['athmahealth'] });
  });

  it('digestInclusion reports included / collecting / disabled per org', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', []);
    seedOrg(prisma, 't1', 'Paused', [], { status: 'disabled' });
    const m = await svc.digestInclusion('t1', INGEST);
    expect([...m.entries()]).toEqual([
      ['athmahealth', 'included'],
      ['NHWebsite', 'collecting'],
      ['Paused', 'disabled'],
    ]);
  });

  it('outside ingest mode every active org is included immediately', async () => {
    const { svc, prisma } = setup();
    seedTenant(prisma, 't1', ['athmahealth/ehr']);
    seedOrg(prisma, 't1', 'NHWebsite', []);
    const c = await svc.coverageForDay('t1', DAY, SHADOW, NOW);
    expect(c).toMatchObject({ applies: false, ok: true, included: ['athmahealth', 'NHWebsite'] });
  });
});
