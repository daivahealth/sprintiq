import { PrismaService } from '../../database/prisma.service';
import { ConnectionsService } from './connections.service';

/**
 * Tenant-isolation contract for BC-0. Uses a mock Prisma client to assert that
 * every read/write is scoped by tenantId — the enforcement the platform depends
 * on (docs/security/AUTH-AND-RBAC.md §4, ADR-0005).
 */
describe('ConnectionsService (tenant isolation)', () => {
  const prisma = {
    connection: {
      create: jest.fn().mockResolvedValue({ id: 'c1' }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ id: 'c1' }),
    },
    rawEvent: {
      groupBy: jest.fn().mockResolvedValue([]),
    },
    schedulerTick: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    connectionSyncRun: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService;

  const svc = new ConnectionsService(prisma);

  afterEach(() => jest.clearAllMocks());

  it('create() persists with the caller tenantId', async () => {
    await svc.create('tenant-a', { sourceSystem: 'github', name: 'acme' });
    expect(prisma.connection.create as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          sourceSystem: 'github',
          status: 'active',
        }),
      }),
    );
  });

  it('listByTenant() filters by tenantId only', async () => {
    await svc.listByTenant('tenant-a');
    expect(prisma.connection.findMany as jest.Mock).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a' },
    });
  });

  it('listActive() has no tenant filter — the scheduler sweep partitions per-connection afterward', async () => {
    await svc.listActive();
    expect(prisma.connection.findMany as jest.Mock).toHaveBeenCalledWith({
      where: { status: 'active' },
    });
  });

  it('setSyncCursors() replaces the cursor blob for one connection', async () => {
    await svc.setSyncCursors('c1', { prBackfillDone: true });
    expect(prisma.connection.update as jest.Mock).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { syncCursors: { prBackfillDone: true } },
    });
  });

  it('setRateLimitState() replaces the rate-limit blob, and {} clears a cooldown', async () => {
    await svc.setRateLimitState('c1', {});
    expect(prisma.connection.update as jest.Mock).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { rateLimitState: {} },
    });
  });

  it('findByTenantSourceAndName() scopes by all three so it never matches an unrelated connection', async () => {
    await svc.findByTenantSourceAndName(
      'tenant-a',
      'github',
      'Managed by tenant configuration (github)',
    );
    expect(prisma.connection.findFirst as jest.Mock).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        sourceSystem: 'github',
        name: 'Managed by tenant configuration (github)',
      },
    });
  });

  it('updateConfig() writes config/secretRef/webhookSecretRef/status in one call', async () => {
    await svc.updateConfig('c1', {
      config: { repoFullName: 'acme/payments' },
      secretRef: 'GITHUB_TOKEN',
      webhookSecretRef: undefined,
      status: 'active',
    });
    expect(prisma.connection.update as jest.Mock).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: {
        config: { repoFullName: 'acme/payments' },
        secretRef: 'GITHUB_TOKEN',
        webhookSecretRef: undefined,
        status: 'active',
      },
    });
  });

  it('setStatus() only touches status', async () => {
    await svc.setStatus('c1', 'disabled');
    expect(prisma.connection.update as jest.Mock).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { status: 'disabled' },
    });
  });

  it('setBackfillCompletedAt() sets the timestamp on that connection only', async () => {
    const at = new Date('2026-06-01T00:00:00.000Z');
    await svc.setBackfillCompletedAt('c1', at);
    expect(prisma.connection.update as jest.Mock).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { backfillCompletedAt: at },
    });
  });
});

describe('ConnectionsService.getSyncStatus', () => {
  const prisma = {
    connection: { findMany: jest.fn() },
    rawEvent: { groupBy: jest.fn() },
    schedulerTick: { findMany: jest.fn() },
    connectionSyncRun: { findMany: jest.fn() },
  } as unknown as PrismaService;
  const svc = new ConnectionsService(prisma);

  afterEach(() => jest.clearAllMocks());

  function connection(overrides: Record<string, unknown> = {}) {
    return {
      id: 'conn_1',
      tenantId: 'tenant-a',
      sourceSystem: 'github',
      name: 'athmahealth/api',
      config: { backfillSince: '2026-05-01T00:00:00.000Z' },
      rateLimitState: {},
      status: 'active',
      backfillCompletedAt: null,
      lastSyncAt: null,
      ...overrides,
    };
  }

  function mockDefaults() {
    (prisma.rawEvent.groupBy as jest.Mock).mockResolvedValue([]);
    (prisma.schedulerTick.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.connectionSyncRun.findMany as jest.Mock).mockResolvedValue([]);
  }

  function github(result: Awaited<ReturnType<typeof svc.getSyncStatus>>) {
    const source = result.sources.find((s) => s.sourceSystem === 'github');
    if (!source) throw new Error('no github source in result');
    return source;
  }

  it('always includes github and jira as sources, even with zero connections', async () => {
    (prisma.connection.findMany as jest.Mock).mockResolvedValue([]);
    mockDefaults();

    const result = await svc.getSyncStatus('tenant-a');

    expect(result.sources.map((s) => s.sourceSystem).sort()).toEqual([
      'github',
      'jira',
    ]);
  });

  it('splits connections into completedRuns (sorted newest-first) and inProgress, per source', async () => {
    (prisma.connection.findMany as jest.Mock).mockResolvedValue([
      connection({
        id: 'done_old',
        backfillCompletedAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
      connection({
        id: 'done_new',
        backfillCompletedAt: new Date('2026-06-10T00:00:00.000Z'),
      }),
      connection({ id: 'in_progress', backfillCompletedAt: null }),
    ]);
    mockDefaults();

    const result = await svc.getSyncStatus('tenant-a');

    const gh = github(result);
    expect(gh.completedRuns.map((r) => r.id)).toEqual(['done_new', 'done_old']);
    expect(gh.inProgress.map((r) => r.id)).toEqual(['in_progress']);
    expect(result.summary).toEqual({
      totalConnections: 3,
      backfillComplete: 2,
      backfillInProgress: 1,
      totalEventsIngested: 0,
    });
  });

  it('attaches ingested-event counts and date range from the raw-event log', async () => {
    (prisma.connection.findMany as jest.Mock).mockResolvedValue([
      connection({ id: 'conn_1' }),
    ]);
    mockDefaults();
    (prisma.rawEvent.groupBy as jest.Mock).mockResolvedValue([
      {
        connectionId: 'conn_1',
        _count: { id: 42 },
        _min: { occurredAt: new Date('2026-05-01T00:00:00.000Z') },
        _max: { occurredAt: new Date('2026-06-01T00:00:00.000Z') },
      },
    ]);

    const result = await svc.getSyncStatus('tenant-a');

    expect(github(result).inProgress[0]).toMatchObject({
      eventsIngested: 42,
      earliestEventAt: new Date('2026-05-01T00:00:00.000Z'),
      latestEventAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    expect(result.summary.totalEventsIngested).toBe(42);
  });

  it("reports a source's tick as running mid-sweep, with a rough ETA extrapolated from progress so far", async () => {
    (prisma.connection.findMany as jest.Mock).mockResolvedValue([]);
    mockDefaults();
    const startedAt = new Date(Date.now() - 10_000); // 10s ago
    (prisma.schedulerTick.findMany as jest.Mock).mockResolvedValue([
      {
        sourceSystem: 'github',
        startedAt,
        finishedAt: null,
        totalConnections: 100,
        connectionsProcessed: 50, // half done in 10s → ~10s more for the rest
      },
    ]);

    const result = await svc.getSyncStatus('tenant-a');

    const gh = github(result);
    expect(gh.tick.running).toBe(true);
    expect(gh.tick.etaSeconds).toBeGreaterThanOrEqual(8);
    expect(gh.tick.etaSeconds).toBeLessThanOrEqual(12);
    // Jira's tick is untouched — sources are fully independent.
    const jira = result.sources.find((s) => s.sourceSystem === 'jira');
    expect(jira?.tick.running).toBe(false);
  });

  it("reports a source's tick as idle between sweeps", async () => {
    (prisma.connection.findMany as jest.Mock).mockResolvedValue([]);
    mockDefaults();
    const finishedAt = new Date('2026-06-01T00:00:00.000Z');
    (prisma.schedulerTick.findMany as jest.Mock).mockResolvedValue([
      {
        sourceSystem: 'github',
        startedAt: new Date('2026-06-01T00:00:00.000Z'),
        finishedAt,
        totalConnections: 10,
        connectionsProcessed: 10,
      },
    ]);

    const result = await svc.getSyncStatus('tenant-a');

    const gh = github(result);
    expect(gh.tick.running).toBe(false);
    expect(gh.tick.etaSeconds).toBeNull();
    expect(gh.tick.finishedAt).toEqual(finishedAt);
  });

  it('surfaces an active rate-limit cooldown but not an expired one', async () => {
    (prisma.connection.findMany as jest.Mock).mockResolvedValue([
      connection({
        id: 'cooling_down',
        rateLimitState: {
          resetAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
      connection({
        id: 'expired_cooldown',
        rateLimitState: {
          resetAt: new Date(Date.now() - 60_000).toISOString(),
        },
      }),
    ]);
    mockDefaults();

    const result = await svc.getSyncStatus('tenant-a');

    const byId = new Map(github(result).inProgress.map((r) => [r.id, r]));
    expect(byId.get('cooling_down')?.rateLimitedUntil).not.toBeNull();
    expect(byId.get('expired_cooldown')?.rateLimitedUntil).toBeNull();
  });

  it('computes nextSyncDueAt from lastSyncAt + the connection’s own syncIntervalMinutes', async () => {
    const lastSyncAt = new Date('2026-06-01T00:00:00.000Z');
    (prisma.connection.findMany as jest.Mock).mockResolvedValue([
      connection({
        id: 'conn_1',
        lastSyncAt,
        config: { syncIntervalMinutes: 60 },
      }),
    ]);
    mockDefaults();

    const result = await svc.getSyncStatus('tenant-a');

    expect(github(result).inProgress[0].nextSyncDueAt).toEqual(
      new Date('2026-06-01T01:00:00.000Z'),
    );
  });

  it('defaults syncIntervalMinutes to 240 (4h) when a connection has none set', async () => {
    (prisma.connection.findMany as jest.Mock).mockResolvedValue([
      connection({ id: 'conn_1', config: {} }),
    ]);
    mockDefaults();

    const result = await svc.getSyncStatus('tenant-a');

    expect(github(result).inProgress[0].syncIntervalMinutes).toBe(240);
  });

  it('scopes recent run history per source, newest first, with connection names attached', async () => {
    (prisma.connection.findMany as jest.Mock).mockResolvedValue([
      connection({ id: 'conn_1', name: 'athmahealth/api' }),
    ]);
    mockDefaults();
    (prisma.connectionSyncRun.findMany as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 'run_2',
          connectionId: 'conn_1',
          sourceSystem: 'github',
          startedAt: new Date('2026-06-02T00:00:00.000Z'),
          finishedAt: new Date('2026-06-02T00:00:05.000Z'),
          eventsFetched: 5,
          eventsIngested: 5,
          status: 'success',
          errorMessage: null,
        },
      ])
      .mockResolvedValueOnce([]); // jira: no runs yet

    const result = await svc.getSyncStatus('tenant-a');

    expect(github(result).history).toEqual([
      expect.objectContaining({
        id: 'run_2',
        connectionName: 'athmahealth/api',
        eventsIngested: 5,
        status: 'success',
      }),
    ]);
    expect(
      result.sources.find((s) => s.sourceSystem === 'jira')?.history,
    ).toEqual([]);
  });
});
