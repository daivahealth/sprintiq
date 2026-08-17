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
    schedulerTick: {
      upsert: jest.Mock;
      update: jest.Mock;
      findUnique: jest.Mock;
    };
    connectionSyncRun: { create: jest.Mock; update: jest.Mock };
  };
  let service: CollectorSchedulerService;

  beforeEach(() => {
    collector = {
      source: 'github',
      normalizeWebhook: jest.fn(),
      poll: jest.fn().mockResolvedValue({ envelopes: [] }),
    };
    connections = {
      findActiveBySource: jest.fn().mockResolvedValue([]),
      touchSync: jest.fn().mockResolvedValue(undefined),
      setCollectedRange: jest.fn().mockResolvedValue(undefined),
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
        // No sweep in flight by default.
        findUnique: jest.fn().mockResolvedValue(null),
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

  it('skips the tick when a sweep for that source is still running', async () => {
    // The cron fires on a fixed cadence regardless of how long the previous
    // sweep took. Two overlapping sweeps both start at the head of the list,
    // spending the rate limit re-polling the same connections while the tail
    // is never reached.
    prisma.schedulerTick.findUnique.mockResolvedValue({
      sourceSystem: 'github',
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: null,
    });

    await service.tickGithub();

    expect(connections.findActiveBySource).not.toHaveBeenCalled();
    expect(prisma.schedulerTick.upsert).not.toHaveBeenCalled();
  });

  it('runs when the previous sweep finished', async () => {
    prisma.schedulerTick.findUnique.mockResolvedValue({
      sourceSystem: 'github',
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(Date.now() - 30_000),
    });

    await service.tickGithub();

    expect(connections.findActiveBySource).toHaveBeenCalledWith('github');
  });

  it('runs anyway when an unfinished sweep is older than the staleness bound', async () => {
    // A process killed mid-sweep leaves the row open forever. Blocking on it
    // indefinitely would strand the source — worse than a duplicate pass.
    prisma.schedulerTick.findUnique.mockResolvedValue({
      sourceSystem: 'github',
      startedAt: new Date(Date.now() - 90 * 60_000),
      finishedAt: null,
    });

    await service.tickGithub();

    expect(connections.findActiveBySource).toHaveBeenCalledWith('github');
  });

  it('closes the sweep out even when the loop throws, so the guard cannot strand the source', async () => {
    connections.findActiveBySource.mockResolvedValue([connection()]);
    prisma.connectionSyncRun.create.mockRejectedValue(new Error('db blip'));

    await expect(service.tickGithub()).rejects.toThrow('db blip');

    expect(prisma.schedulerTick.update).toHaveBeenCalledWith({
      where: { sourceSystem: 'github' },
      data: { finishedAt: expect.any(Date) },
    });
  });

  it('ingests every envelope a collector returns, under that connection tenant context', async () => {
    connections.findActiveBySource.mockResolvedValue([connection()]);
    collector.poll.mockResolvedValue({
      envelopes: [
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
      ],
    });
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
      .mockResolvedValueOnce({ envelopes: [] });

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

  it('polls a connection with a pending sync request, even when its interval says otherwise', async () => {
    // "Sync now" has to beat the interval, or it means "in up to four hours".
    connections.findActiveBySource.mockResolvedValue([
      connection({
        id: 'requested',
        lastSyncAt: new Date(),
        backfillCompletedAt: new Date(Date.now() - 24 * 60 * 60_000),
        syncRequestedAt: new Date(),
        config: { syncIntervalMinutes: 240 },
      }),
    ]);

    await service.tickGithub();

    expect(collector.poll).toHaveBeenCalledTimes(1);
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

  it('never stamps lastSyncAt for a pass that never reached the source', async () => {
    // A connection in a rate-limit cooldown returns immediately without calling
    // GitHub at all. Stamping lastSyncAt anyway reports it as freshly synced on
    // every dashboard AND drops it to the back of the neediest-first queue —
    // the exact starvation the ordering exists to prevent.
    connections.findActiveBySource.mockResolvedValue([
      connection({ id: 'cooling_down' }),
    ]);
    collector.poll.mockResolvedValue({
      envelopes: [],
      skipped: 'rate-limited',
    });

    await service.tickGithub();

    expect(connections.touchSync).not.toHaveBeenCalled();
  });

  it('records a skipped pass as skipped, not as a zero-event success', async () => {
    connections.findActiveBySource.mockResolvedValue([
      connection({ id: 'cooling_down' }),
    ]);
    collector.poll.mockResolvedValue({
      envelopes: [],
      skipped: 'rate-limited',
    });

    await service.tickGithub();

    expect(prisma.connectionSyncRun.update).toHaveBeenCalledWith({
      where: { id: 'run_1' },
      data: expect.objectContaining({ status: 'skipped' }),
    });
  });

  it('records a pass the source rejected as an error, not a zero-event success', async () => {
    // The same defect as the rate-limit case, entering through a different
    // door: a revoked token, renamed repo or SSO-blocked org means every
    // request is refused, the collector collects nothing, and reporting that
    // as a successful sync stamps lastSyncAt and demotes the connection in the
    // neediest-first queue — exactly what it must not do.
    connections.findActiveBySource.mockResolvedValue([connection()]);
    collector.poll.mockResolvedValue({ envelopes: [], failed: true });

    await service.tickGithub();

    expect(connections.touchSync).not.toHaveBeenCalled();
    expect(prisma.connectionSyncRun.update).toHaveBeenCalledWith({
      where: { id: 'run_1' },
      data: expect.objectContaining({ status: 'error' }),
    });
  });

  it('still ingests whatever a partially-failed pass did collect', async () => {
    // Half a pass can succeed — PRs land, commits are refused. Those envelopes
    // are real collected data and discarding them would lose it; only the
    // "this connection is up to date" claim is withheld.
    connections.findActiveBySource.mockResolvedValue([connection()]);
    collector.poll.mockResolvedValue({
      envelopes: [
        {
          schemaVersion: '1.0',
          eventId: 'e1',
          idempotencyKey: 'k1',
          sourceSystem: 'github',
          connectionId: 'conn_1',
          collectionMode: 'poll',
          eventType: 't',
          occurredAt: 'now',
          collectedAt: 'now',
          externalRefs: {},
          data: {},
        },
      ],
      failed: true,
    });

    await service.tickGithub();

    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
    expect(connections.touchSync).not.toHaveBeenCalled();
  });

  it('persists the completeness watermark a successful pass reports', async () => {
    const through = new Date('2026-08-17T09:00:00.000Z');
    connections.findActiveBySource.mockResolvedValue([connection()]);
    collector.poll.mockResolvedValue({
      envelopes: [],
      collectedThroughAt: through,
    });

    await service.tickGithub();

    expect(connections.setCollectedRange).toHaveBeenCalledWith('conn_1', {
      throughAt: through,
      backTo: undefined,
    });
  });

  it('persists a lower bound reported without an upper one', async () => {
    // The mid-backfill shape for GitHub: it has walked back to a point but has
    // not finished, so it can state how deep it has got without yet claiming
    // to be complete through anything. Requiring both would discard the half
    // that makes a recent-window board judgeable.
    const backTo = new Date('2026-05-01T00:00:00.000Z');
    connections.findActiveBySource.mockResolvedValue([connection()]);
    collector.poll.mockResolvedValue({
      envelopes: [],
      collectedBackTo: backTo,
    });

    await service.tickGithub();

    expect(connections.setCollectedRange).toHaveBeenCalledWith('conn_1', {
      throughAt: undefined,
      backTo,
    });
  });

  it('leaves the completeness watermark alone when a pass reports none', async () => {
    // Mid-backfill: the connection talked to the source and made progress, but
    // is not complete through any point yet. Writing "now" here would claim
    // completeness the pass never established.
    connections.findActiveBySource.mockResolvedValue([connection()]);
    collector.poll.mockResolvedValue({ envelopes: [] });

    await service.tickGithub();

    expect(connections.setCollectedRange).not.toHaveBeenCalled();
  });

  it('tells each collector how many peers share its credential, since the rate limit is per token', async () => {
    // Not global: dividing one tenant's budget by another tenant's fleet size
    // would starve the small tenant for no reason. Not per-tenant either — see
    // the next test.
    connections.findActiveBySource.mockResolvedValue([
      connection({ id: 'a', tenantId: 't1', secretRef: 'TOKEN_A' }),
      connection({ id: 'b', tenantId: 't1', secretRef: 'TOKEN_A' }),
      connection({ id: 'c', tenantId: 't2', secretRef: 'TOKEN_B' }),
    ]);

    await service.tickGithub();

    expect(collector.poll).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
      { peersDue: 2 },
    );
    expect(collector.poll).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c' }),
      { peersDue: 1 },
    );
  });

  it('divides per credential, not per tenant — one tenant may hold several tokens', async () => {
    // Grouping on tenant alone under-divided here: both groups would claim a
    // full budget, against limits they do not in fact share with each other
    // but which each token enforces separately. Two connections on TOKEN_A get
    // 2; the lone TOKEN_B connection gets its own full share.
    connections.findActiveBySource.mockResolvedValue([
      connection({ id: 'a', tenantId: 't1', secretRef: 'TOKEN_A' }),
      connection({ id: 'b', tenantId: 't1', secretRef: 'TOKEN_A' }),
      connection({ id: 'c', tenantId: 't1', secretRef: 'TOKEN_B' }),
    ]);

    await service.tickGithub();

    expect(collector.poll).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
      { peersDue: 2 },
    );
    expect(collector.poll).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c' }),
      { peersDue: 1 },
    );
  });

  it('counts only DUE peers, not every registered connection', async () => {
    // The budget is spent by the connections actually polled this sweep.
    // Dividing by the whole registry would shrink every share for connections
    // that are not going to run at all.
    connections.findActiveBySource.mockResolvedValue([
      connection({ id: 'due', tenantId: 't1' }),
      connection({
        id: 'not_due',
        tenantId: 't1',
        lastSyncAt: new Date(),
        backfillCompletedAt: new Date(Date.now() - 24 * 60 * 60_000),
        config: { syncIntervalMinutes: 240 },
      }),
    ]);

    await service.tickGithub();

    expect(collector.poll).toHaveBeenCalledTimes(1);
    expect(collector.poll).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'due' }),
      { peersDue: 1 },
    );
  });

  it('records a ConnectionSyncRun per connection actually synced, tenant-scoped', async () => {
    connections.findActiveBySource.mockResolvedValue([connection()]);
    collector.poll.mockResolvedValue({ envelopes: [] });

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

/**
 * Fairness + overlap. Both only bite at org scale — an org sync registers one
 * connection per repo (195 on a real tenant), a full sweep takes far longer
 * than the 5-minute cadence, and connections still backfilling are always due
 * regardless of their interval.
 */
/**
 * Bounded concurrency. A serial sweep of 195 connections takes far longer than
 * the tick cadence, so the wall-clock — not the API budget — becomes what
 * bounds how often a connection is reached. Overlapping a few connections cuts
 * that without raising spend, because spend is now governed by the shared
 * per-sweep budget rather than by how many run at once.
 */
describe('CollectorSchedulerService — bounded concurrency', () => {
  function build(connectionList: Connection[]) {
    const collector: jest.Mocked<SourceCollector> = {
      source: 'github',
      normalizeWebhook: jest.fn(),
      poll: jest.fn().mockResolvedValue({ envelopes: [] }),
    };
    const connections = {
      findActiveBySource: jest.fn().mockResolvedValue(connectionList),
      touchSync: jest.fn().mockResolvedValue(undefined),
      setCollectedRange: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ConnectionsService>;
    const ingestion = {
      ingest: jest.fn().mockResolvedValue({ status: 'accepted', eventId: 'e' }),
    };
    const prisma = {
      schedulerTick: {
        upsert: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      connectionSyncRun: {
        create: jest.fn().mockResolvedValue({ id: 'run_1' }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const tenantContext = new TenantContextService();
    const service = new CollectorSchedulerService(
      connections,
      {
        get: jest.fn().mockReturnValue(collector),
      } as unknown as jest.Mocked<CollectorRegistry>,
      ingestion as never,
      tenantContext,
      prisma as unknown as PrismaService,
    );
    return { service, collector, connections, ingestion, tenantContext };
  }

  it('never runs more than the configured number of connections at once', async () => {
    const list = Array.from({ length: 12 }, (_, i) =>
      connection({ id: `c${i}` }),
    );
    const { service, collector } = build(list);
    let inFlight = 0;
    let peak = 0;
    collector.poll.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { envelopes: [] };
    });

    await service.tickGithub();

    expect(collector.poll).toHaveBeenCalledTimes(12);
    expect(peak).toBeGreaterThan(1); // actually concurrent
    expect(peak).toBeLessThanOrEqual(4); // but bounded
  });

  it('keeps every ingest under its own connection tenant, even while others are in flight', async () => {
    // The isolation that concurrency puts at risk. A implementation that
    // entered the tenant context once around the loop — rather than per
    // connection — would write one tenant's events under another's id, the
    // single worst failure this system can have.
    const { service, collector, ingestion, tenantContext } = build([
      connection({ id: 'slow', tenantId: 'tenant-slow' }),
      connection({ id: 'fast', tenantId: 'tenant-fast' }),
    ]);
    const envelope = (id: string) =>
      ({
        schemaVersion: '1.0',
        eventId: id,
        idempotencyKey: id,
        sourceSystem: 'github',
        connectionId: id,
        collectionMode: 'poll',
        eventType: 't',
        occurredAt: 'now',
        collectedAt: 'now',
        externalRefs: {},
        data: {},
      }) as never;
    collector.poll.mockImplementation(async (c: Connection) => {
      // The slow one is still mid-flight when the fast one ingests.
      await new Promise((r) => setTimeout(r, c.id === 'slow' ? 20 : 1));
      return { envelopes: [envelope(c.id)] };
    });
    // Read from the AsyncLocalStorage store, NOT from the tenantId argument.
    // `syncOne` passes that argument explicitly, so asserting on it would pass
    // even if the store were shared or empty — proving nothing about the
    // isolation this test exists to cover.
    const seen: Record<string, string | undefined> = {};
    ingestion.ingest.mockImplementation(
      async (_tenantId: string, e: { eventId: string }) => {
        seen[e.eventId] = tenantContext.tenantId;
        return { status: 'accepted', eventId: e.eventId };
      },
    );

    await service.tickGithub();

    expect(seen).toEqual({ slow: 'tenant-slow', fast: 'tenant-fast' });
  });
});

/**
 * The day-close pass. Everything else in the scheduler is a rolling interval,
 * which has no notion of a day at all — a repo polled at 21:00 on a 4h interval
 * is not polled again until 01:00, so its evening work lands *tomorrow*. This
 * is the only thing that ties collection to the calendar day the dashboards
 * report on.
 */
describe('CollectorSchedulerService — IST day close', () => {
  let connections: jest.Mocked<ConnectionsService>;
  let service: CollectorSchedulerService;

  beforeEach(() => {
    connections = {
      findActiveBySource: jest.fn().mockResolvedValue([]),
      touchSync: jest.fn().mockResolvedValue(undefined),
      setCollectedRange: jest.fn().mockResolvedValue(undefined),
      requestSyncForAllActive: jest.fn().mockResolvedValue(3),
    } as unknown as jest.Mocked<ConnectionsService>;
    service = new CollectorSchedulerService(
      connections,
      { get: jest.fn() } as unknown as jest.Mocked<CollectorRegistry>,
      {} as never,
      new TenantContextService(),
      {} as unknown as PrismaService,
    );
  });

  it('queues every active connection so the day closes with its own data collected', async () => {
    await service.closeOutTheDay();

    expect(connections.requestSyncForAllActive).toHaveBeenCalledTimes(1);
  });

  it('queues rather than sweeping inline, so the close cannot collide with a running sweep', async () => {
    // Setting the flag is the whole action: the ordinary 5-minute tick then
    // picks the connections up under the existing single-sweep guard. Running
    // a sweep from here would be a second concurrent pass over the same
    // connections, spending the rate limit twice on the same work.
    await service.closeOutTheDay();

    expect(connections.findActiveBySource).not.toHaveBeenCalled();
  });
});

describe('CollectorSchedulerService — org-scale sweep behaviour', () => {
  it('asks for connections neediest-first so the backlog converges instead of starving', async () => {
    const prisma = {
      connection: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const svc = new ConnectionsService(prisma);

    await svc.findActiveBySource('github');

    // Unordered, every sweep restarts at the same head of the list and the
    // tail is never reached at all. Explicitly requested connections come
    // first, or "sync now" means "somewhere in the next 195 connections".
    expect(prisma.connection.findMany as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { syncRequestedAt: { sort: 'desc', nulls: 'last' } },
          { lastSyncAt: { sort: 'asc', nulls: 'first' } },
        ],
      }),
    );
  });
});

describe('ConnectionsService — sync progress and requests', () => {
  function setup() {
    const updates: Record<string, unknown>[] = [];
    const prisma = {
      connection: {
        findUnique: jest.fn().mockResolvedValue({ config: {} }),
        update: jest.fn(async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return args.data;
        }),
      },
    } as unknown as PrismaService;
    return { service: new ConnectionsService(prisma), updates };
  }

  it('clears the backfill-complete marker along with the cursors', async () => {
    // Leaving it set tells the scheduler this connection needs no priority at
    // exactly the moment it needs the most, and tells the Sync Status screen
    // the backfill is finished while it is walking history again.
    const { service, updates } = setup();

    await service.clearSyncProgress('c1');

    expect(updates[0]).toMatchObject({
      syncCursors: {},
      backfillCompletedAt: null,
      collectedThroughAt: null,
    });
  });

  it('clears a pending sync request once the connection actually syncs', async () => {
    // Left set, the connection would pin itself to the head of every
    // subsequent sweep — the starvation the ordering exists to prevent.
    const { service, updates } = setup();

    await service.touchSync('c1');

    expect(updates[0]).toMatchObject({ syncRequestedAt: null });
  });

  it('does not clear a pending sync request for a pass that was skipped', async () => {
    // `touchSync` is the only thing that clears it, and a skipped pass never
    // calls it — so a request survives a rate-limit cooldown and is honoured
    // on the next sweep that can actually reach the source.
    const { service, updates } = setup();

    await service.requestSync('c1');

    expect(updates[0]).toMatchObject({ syncRequestedAt: expect.any(Date) });
  });
});
