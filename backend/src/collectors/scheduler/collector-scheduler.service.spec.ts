import { Connection } from '@prisma/client';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { PrismaService } from '../../database/prisma.service';
import { ConnectionsService } from '../../modules/connections/connections.service';
import { CollectorRegistry } from '../framework/collector.registry';
import { SourceCollector } from '../framework/source-collector';
import { CollectorSchedulerService } from './collector-scheduler.service';

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn_1',
    tenantId: 'tenant-a',
    sourceSystem: 'github',
    name: 'acme/payments',
    config: {},
    secretRef: null,
    webhookSecretRef: null,
    syncCursors: {},
    rateLimitState: {},
    status: 'active',
    lastSyncAt: null,
    syncLagSeconds: 0,
    backfillCompletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Connection;
}

describe('CollectorSchedulerService', () => {
  let connections: jest.Mocked<ConnectionsService>;
  let registry: jest.Mocked<CollectorRegistry>;
  let ingestion: {
    ingest: jest.Mock;
  };
  let tenantContext: TenantContextService;
  let collector: jest.Mocked<SourceCollector>;
  let prisma: {
    schedulerTick: { upsert: jest.Mock; update: jest.Mock };
    connectionSyncRun: { create: jest.Mock; update: jest.Mock };
  };
  let service: CollectorSchedulerService;

  beforeEach(() => {
    collector = {
      source: 'github',
      normalizeWebhook: jest.fn(),
      poll: jest.fn().mockResolvedValue([]),
    };
    connections = {
      findActiveBySource: jest.fn().mockResolvedValue([]),
      touchSync: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ConnectionsService>;
    registry = {
      get: jest.fn().mockReturnValue(collector),
    } as unknown as jest.Mocked<CollectorRegistry>;
    ingestion = {
      ingest: jest
        .fn()
        .mockResolvedValue({ status: 'accepted', eventId: 'e1' }),
    };
    tenantContext = new TenantContextService();
    prisma = {
      schedulerTick: {
        upsert: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      },
      connectionSyncRun: {
        create: jest.fn().mockResolvedValue({ id: 'run_1' }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    service = new CollectorSchedulerService(
      connections,
      registry,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ingestion as any,
      tenantContext,
      prisma as unknown as PrismaService,
    );
  });

  it('ingests every envelope a collector returns, under that connection tenant context', async () => {
    connections.findActiveBySource.mockResolvedValue([connection()]);
    collector.poll.mockResolvedValue([
      {
        schemaVersion: '1.0',
        eventId: 'e1',
        idempotencyKey: 'k1',
        sourceSystem: 'github',
        connectionId: 'conn_1',
        collectionMode: 'backfill',
        eventType: 't',
        occurredAt: 'now',
        collectedAt: 'now',
        externalRefs: {},
        data: {},
      },
    ]);
    let observedTenantDuringIngest: string | undefined;
    ingestion.ingest.mockImplementation(async (tenantId: string) => {
      observedTenantDuringIngest = tenantId;
      return { status: 'accepted', eventId: 'e1' };
    });

    await service.tickGithub();

    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
    expect(observedTenantDuringIngest).toBe('tenant-a');
    expect(connections.touchSync).toHaveBeenCalledWith('conn_1');
  });

  it('only checks the source it was asked to tick', async () => {
    connections.findActiveBySource.mockResolvedValue([]);

    await service.tickJira();

    expect(connections.findActiveBySource).toHaveBeenCalledWith('jira');
  });

  it('skips a connection whose source has no registered collector', async () => {
    connections.findActiveBySource.mockResolvedValue([
      connection({ sourceSystem: 'gitlab' }),
    ]);
    registry.get.mockReturnValue(undefined);

    await service.tickGithub();

    expect(collector.poll).not.toHaveBeenCalled();
  });

  it("isolates one connection's failure — the sweep still processes the rest", async () => {
    connections.findActiveBySource.mockResolvedValue([
      connection({ id: 'bad' }),
      connection({ id: 'good' }),
    ]);
    collector.poll
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);

    await expect(service.tickGithub()).resolves.toBeUndefined();

    expect(collector.poll).toHaveBeenCalledTimes(2);
    expect(connections.touchSync).toHaveBeenCalledWith('good');
    expect(connections.touchSync).not.toHaveBeenCalledWith('bad');
  });

  it('records an error ConnectionSyncRun (not a success one) when a connection fails', async () => {
    connections.findActiveBySource.mockResolvedValue([
      connection({ id: 'bad' }),
    ]);
    collector.poll.mockRejectedValueOnce(new Error('boom'));

    await service.tickGithub();

    expect(prisma.connectionSyncRun.update).toHaveBeenCalledWith({
      where: { id: 'run_1' },
      data: expect.objectContaining({ status: 'error', errorMessage: 'boom' }),
    });
  });

  it('always polls a connection still mid-backfill, regardless of syncIntervalMinutes (not yet due by interval)', async () => {
    connections.findActiveBySource.mockResolvedValue([
      connection({
        id: 'still_backfilling',
        lastSyncAt: new Date(), // "just synced" — would fail the interval check
        backfillCompletedAt: null,
        config: { syncIntervalMinutes: 240 },
      }),
    ]);

    await service.tickGithub();

    // The interval must never stall backfill progress — it only throttles
    // steady-state polling once backfillCompletedAt is set.
    expect(collector.poll).toHaveBeenCalledTimes(1);
  });

  it('never polls a connection past its backfill whose own syncIntervalMinutes has not elapsed since lastSyncAt', async () => {
    connections.findActiveBySource.mockResolvedValue([
      connection({
        id: 'not_due',
        lastSyncAt: new Date(),
        backfillCompletedAt: new Date(Date.now() - 24 * 60 * 60_000),
        config: { syncIntervalMinutes: 240 },
      }),
    ]);

    await service.tickGithub();

    expect(collector.poll).not.toHaveBeenCalled();
    expect(prisma.schedulerTick.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ totalConnections: 0 }),
      }),
    );
  });

  it('polls a connection past its backfill once its own syncIntervalMinutes has elapsed since lastSyncAt', async () => {
    connections.findActiveBySource.mockResolvedValue([
      connection({
        id: 'due',
        lastSyncAt: new Date(Date.now() - 10 * 60_000),
        backfillCompletedAt: new Date(Date.now() - 24 * 60 * 60_000),
        config: { syncIntervalMinutes: 5 },
      }),
    ]);

    await service.tickGithub();

    expect(collector.poll).toHaveBeenCalledTimes(1);
  });

  it('defaults to a 4-hour interval when a connection past its backfill has no syncIntervalMinutes set', async () => {
    connections.findActiveBySource.mockResolvedValue([
      connection({
        id: 'no_config',
        lastSyncAt: new Date(Date.now() - 60 * 60_000), // 1h ago — under the 4h default
        backfillCompletedAt: new Date(Date.now() - 24 * 60 * 60_000),
        config: {},
      }),
    ]);

    await service.tickGithub();

    expect(collector.poll).not.toHaveBeenCalled();
  });

  it('always syncs a connection that has never synced before, regardless of interval', async () => {
    connections.findActiveBySource.mockResolvedValue([
      connection({ id: 'never_synced', lastSyncAt: null }),
    ]);

    await service.tickGithub();

    expect(collector.poll).toHaveBeenCalledTimes(1);
  });

  it("tracks tick start/progress/finish in that source's own SchedulerTick row", async () => {
    connections.findActiveBySource.mockResolvedValue([
      connection({ id: 'a' }),
      connection({ id: 'b' }),
    ]);

    await service.tickGithub();

    expect(prisma.schedulerTick.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sourceSystem: 'github' },
        create: expect.objectContaining({
          sourceSystem: 'github',
          finishedAt: null,
          totalConnections: 2,
          connectionsProcessed: 0,
        }),
        update: expect.objectContaining({
          finishedAt: null,
          totalConnections: 2,
          connectionsProcessed: 0,
        }),
      }),
    );
    // once per connection processed, then a final finishedAt write
    expect(prisma.schedulerTick.update).toHaveBeenCalledTimes(3);
    expect(prisma.schedulerTick.update).toHaveBeenNthCalledWith(1, {
      where: { sourceSystem: 'github' },
      data: { connectionsProcessed: { increment: 1 } },
    });
    expect(prisma.schedulerTick.update).toHaveBeenNthCalledWith(2, {
      where: { sourceSystem: 'github' },
      data: { connectionsProcessed: { increment: 1 } },
    });
    expect(prisma.schedulerTick.update).toHaveBeenNthCalledWith(3, {
      where: { sourceSystem: 'github' },
      data: { finishedAt: expect.any(Date) },
    });
  });

  it('records a ConnectionSyncRun per connection actually synced, tenant-scoped', async () => {
    connections.findActiveBySource.mockResolvedValue([connection()]);
    collector.poll.mockResolvedValue([]);

    await service.tickGithub();

    expect(prisma.connectionSyncRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-a',
        connectionId: 'conn_1',
        sourceSystem: 'github',
        status: 'running',
      }),
    });
    expect(prisma.connectionSyncRun.update).toHaveBeenCalledWith({
      where: { id: 'run_1' },
      data: expect.objectContaining({
        status: 'success',
        eventsFetched: 0,
        eventsIngested: 0,
      }),
    });
  });
});
