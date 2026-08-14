import { Injectable } from '@nestjs/common';
import { Connection, Prisma } from '@prisma/client';
import { newId } from '../../common/id';
import { PrismaService } from '../../database/prisma.service';
import {
  DEFAULT_SYNC_INTERVAL_MINUTES,
  SCHEDULED_SOURCE_SYSTEMS,
  SourceSystem,
} from './connection.types';

export interface ConnectionSyncStatus {
  id: string;
  sourceSystem: string;
  name: string;
  status: string;
  syncIntervalMinutes: number;
  backfillSince: string | null;
  backfillCompletedAt: Date | null;
  lastSyncAt: Date | null;
  /** Computed from lastSyncAt + this connection's own syncIntervalMinutes. */
  nextSyncDueAt: Date;
  eventsIngested: number;
  earliestEventAt: Date | null;
  latestEventAt: Date | null;
  rateLimitedUntil: string | null;
  /**
   * Why the last pass didn't reach the source, if it didn't. Zero events is
   * ambiguous on its own — this is what separates "nothing changed" from
   * "couldn't run".
   */
  lastError: string | null;
  lastErrorAt: Date | null;
}

export interface SyncRunHistoryEntry {
  id: string;
  connectionId: string;
  connectionName: string;
  startedAt: Date;
  finishedAt: Date | null;
  eventsFetched: number;
  eventsIngested: number;
  status: string;
  errorMessage: string | null;
}

export interface SourceSyncStatus {
  sourceSystem: string;
  tick: {
    running: boolean;
    startedAt: Date | null;
    finishedAt: Date | null;
    totalConnections: number;
    connectionsProcessed: number;
    /** Rough — extrapolated from this tick's average time-per-connection so far. */
    etaSeconds: number | null;
  };
  inProgress: ConnectionSyncStatus[];
  completedRuns: (ConnectionSyncStatus & { backfillCompletedAt: Date })[];
  /** Most recent sync runs for this source's connections, newest first. */
  history: SyncRunHistoryEntry[];
}

export interface SyncStatusView {
  summary: {
    totalConnections: number;
    backfillComplete: number;
    backfillInProgress: number;
    totalEventsIngested: number;
    /**
     * Connections whose last pass failed, rolled up so one call answers "is
     * the backfill healthy?" — the per-connection lastError deeper in the
     * tree requires walking every source's arrays to reach the same verdict.
     */
    failing: {
      sourceSystem: string;
      name: string;
      error: string;
      lastErrorAt: Date | null;
    }[];
    /**
     * Connections currently paused in a rate-limit cooldown. A pause is
     * expected during a deep backfill (reserve protection), not a failure —
     * but it explains why progress has a slow tail.
     */
    rateLimited: number;
  };
  /** One entry per source that has its own scheduled tick (github, jira) — always present, even with 0 connections. */
  sources: SourceSyncStatus[];
}

/**
 * How current the data behind a dashboard number actually is
 * (METRICS.md §9 `data_freshness`).
 *
 * Deliberately the WORST case across the tenant's active connections, not an
 * average or the newest: a board mixes Jira and GitHub facts, so the oldest
 * sync is the honest bound on the whole screen. A connection that has never
 * synced, or is failing, makes the number unbounded rather than merely old —
 * both are reported separately instead of being folded into a timestamp that
 * would still look recent.
 */
export interface DataFreshness {
  /** Oldest successful sync across active connections; null if none has ever synced. */
  lastSyncAt: Date | null;
  /** Seconds since `lastSyncAt`; null when nothing has synced yet. */
  staleSeconds: number | null;
  /** Active connections with no successful sync yet — their data is absent, not stale. */
  neverSynced: number;
  /** Active connections whose last pass failed, so their slice is frozen at an unknown age. */
  failing: { sourceSystem: string; name: string; error: string }[];
  /** Per-source newest sync, so the UI can say which side is behind. */
  sources: { sourceSystem: string; lastSyncAt: Date | null }[];
}

const HISTORY_PAGE_SIZE = 20;

export interface CreateConnectionInput {
  sourceSystem: SourceSystem;
  name: string;
  config?: Record<string, unknown>;
  secretRef?: string;
  webhookSecretRef?: string;
}

/**
 * BC-0 registry of source connections + health. Collectors resolve which tenant
 * a webhook/poll belongs to via this registry and read credentials/cursors here.
 */
@Injectable()
export class ConnectionsService {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<Connection | null> {
    return this.prisma.connection.findUnique({ where: { id } });
  }

  create(tenantId: string, input: CreateConnectionInput): Promise<Connection> {
    return this.prisma.connection.create({
      data: {
        id: newId(),
        tenantId,
        sourceSystem: input.sourceSystem,
        name: input.name,
        config: (input.config ?? {}) as Prisma.InputJsonValue,
        secretRef: input.secretRef,
        webhookSecretRef: input.webhookSecretRef,
        syncCursors: {},
        rateLimitState: {},
        status: 'active',
      },
    });
  }

  listByTenant(tenantId: string): Promise<Connection[]> {
    return this.prisma.connection.findMany({ where: { tenantId } });
  }

  /**
   * Active connections for a source, **neediest first**: never-synced before
   * ever-synced, then oldest sync first.
   *
   * The order is load-bearing at scale, not cosmetic. An org sync registers one
   * connection per repo (195 on a real tenant), a full sweep of that many takes
   * far longer than the 5-minute tick cadence, and connections still backfilling
   * are always due regardless of their interval (`isDue`). Returned unordered,
   * every sweep restarts at the same head of the list and re-polls repos that
   * synced minutes ago, while the tail is never reached at all — the backlog
   * starves rather than converges. Ordering by neediness makes each sweep pick
   * up where collection is actually missing.
   */
  findActiveBySource(source: SourceSystem): Promise<Connection[]> {
    return this.prisma.connection.findMany({
      where: { sourceSystem: source, status: 'active' },
      orderBy: { lastSyncAt: { sort: 'asc', nulls: 'first' } },
    });
  }

  /**
   * Looks up a connection by its distinguishing `name` within one tenant+source
   * — used by callers (e.g. the admin Configuration screen bridge) that own a
   * single well-known connection per namespace and must not collide with other
   * independently-registered connections for the same source system.
   */
  findByTenantSourceAndName(
    tenantId: string,
    sourceSystem: string,
    name: string,
  ): Promise<Connection | null> {
    return this.prisma.connection.findFirst({
      where: { tenantId, sourceSystem, name },
    });
  }

  /**
   * All active connections across every tenant — used only by the scheduled
   * sync sweep (BC-1), which then partitions all downstream work by each
   * connection's own tenantId. Never used to serve tenant-facing data.
   */
  listActive(): Promise<Connection[]> {
    return this.prisma.connection.findMany({ where: { status: 'active' } });
  }

  async touchSync(id: string, lagSeconds = 0): Promise<void> {
    await this.prisma.connection.update({
      where: { id },
      data: { lastSyncAt: new Date(), syncLagSeconds: lagSeconds },
    });
  }

  /**
   * How stale the tenant's data is right now — what every dashboard shows
   * beside its numbers so a four-hour-old figure isn't read as live.
   *
   * Only `active` connections count: a disabled one isn't expected to be
   * current, so including it would report permanent staleness for a source the
   * tenant deliberately turned off.
   */
  /**
   * How far BACK the data goes, per source — the counterpart to freshness.
   *
   * Collection is windowed: nothing before a connection's `backfillSince` was
   * ever fetched, so a board reaching past it isn't showing less activity, it
   * is showing the edge of the dataset. Reported as the NEWEST floor across a
   * source's connections, because that is the point before which coverage stops
   * being uniform — one repo backfilled deeper than its siblings doesn't make
   * the source's history complete to that depth.
   */
  async getDataHorizon(tenantId: string): Promise<Record<string, string>> {
    const connections = await this.prisma.connection.findMany({
      where: { tenantId, status: 'active' },
      select: { sourceSystem: true, config: true },
    });

    const horizon: Record<string, Date> = {};
    for (const c of connections) {
      const raw = (c.config as { backfillSince?: string } | null)
        ?.backfillSince;
      if (!raw) {
        continue;
      }
      const floor = new Date(raw);
      if (Number.isNaN(floor.getTime())) {
        continue;
      }
      const current = horizon[c.sourceSystem];
      if (!current || floor > current) {
        horizon[c.sourceSystem] = floor;
      }
    }

    return Object.fromEntries(
      Object.entries(horizon).map(([source, at]) => [source, at.toISOString()]),
    );
  }

  async getDataFreshness(tenantId: string): Promise<DataFreshness> {
    const connections = await this.prisma.connection.findMany({
      where: { tenantId, status: 'active' },
      select: {
        sourceSystem: true,
        name: true,
        lastSyncAt: true,
        lastError: true,
      },
    });

    const synced = connections.filter(
      (c): c is (typeof connections)[number] & { lastSyncAt: Date } =>
        c.lastSyncAt !== null,
    );
    // The OLDEST sync bounds the whole screen: a board mixes sources, so the
    // freshest one says nothing about the number sitting next to it.
    const lastSyncAt = synced.length
      ? synced.reduce(
          (oldest, c) => (c.lastSyncAt < oldest ? c.lastSyncAt : oldest),
          synced[0].lastSyncAt,
        )
      : null;

    // Per source: the NEWEST sync among its connections. A never-synced
    // connection must not pin its source to null once a sibling has synced —
    // it is already counted in `neverSynced`.
    const bySource = new Map<string, Date | null>();
    for (const c of connections) {
      if (!bySource.has(c.sourceSystem)) {
        bySource.set(c.sourceSystem, c.lastSyncAt);
        continue;
      }
      const current = bySource.get(c.sourceSystem) ?? null;
      if (c.lastSyncAt && (current === null || c.lastSyncAt > current)) {
        bySource.set(c.sourceSystem, c.lastSyncAt);
      }
    }

    return {
      lastSyncAt,
      staleSeconds: lastSyncAt
        ? Math.max(0, Math.round((Date.now() - lastSyncAt.getTime()) / 1000))
        : null,
      neverSynced: connections.length - synced.length,
      failing: connections
        .filter((c) => c.lastError)
        .map((c) => ({
          sourceSystem: c.sourceSystem,
          name: c.name,
          error: c.lastError as string,
        })),
      sources: [...bySource.entries()]
        .map(([sourceSystem, at]) => ({ sourceSystem, lastSyncAt: at }))
        .sort((a, b) => a.sourceSystem.localeCompare(b.sourceSystem)),
    };
  }

  /** Marks the connection's one-time historical backfill as complete (Sync Status screen). */
  async setBackfillCompletedAt(
    id: string,
    at: Date = new Date(),
  ): Promise<void> {
    await this.prisma.connection.update({
      where: { id },
      data: { backfillCompletedAt: at },
    });
  }

  /**
   * Aggregates everything the Sync Status screen needs, PER SOURCE (GitHub
   * and Jira are ticked and configured independently, docs/api/README.md
   * §3/§7.1): per-connection backfill progress + ingested volume/date
   * coverage (from the raw-event log, so it's accurate for every event type
   * uniformly), whether that source's tick is running right now with a rough
   * ETA, and the recent run history (what synced, and when).
   */
  async getSyncStatus(tenantId: string): Promise<SyncStatusView> {
    const [connections, eventStats, ticks, historyBySource] = await Promise.all(
      [
        this.prisma.connection.findMany({ where: { tenantId } }),
        this.prisma.rawEvent.groupBy({
          by: ['connectionId'],
          where: { tenantId },
          _count: { id: true },
          _min: { occurredAt: true },
          _max: { occurredAt: true },
          orderBy: { connectionId: 'asc' },
        }),
        this.prisma.schedulerTick.findMany(),
        Promise.all(
          SCHEDULED_SOURCE_SYSTEMS.map((sourceSystem) =>
            this.prisma.connectionSyncRun.findMany({
              where: { tenantId, sourceSystem },
              orderBy: { startedAt: 'desc' },
              take: HISTORY_PAGE_SIZE,
            }),
          ),
        ),
      ],
    );

    const statsByConn = new Map(eventStats.map((s) => [s.connectionId, s]));
    const nameByConn = new Map(connections.map((c) => [c.id, c.name]));
    const now = Date.now();

    const items: ConnectionSyncStatus[] = connections.map((c) => {
      const stats = statsByConn.get(c.id);
      const config = (c.config ?? {}) as {
        backfillSince?: string;
        syncIntervalMinutes?: number;
      };
      const rateLimitState = (c.rateLimitState ?? {}) as { resetAt?: string };
      const rateLimitedUntil =
        rateLimitState.resetAt &&
        new Date(rateLimitState.resetAt).getTime() > now
          ? rateLimitState.resetAt
          : null;
      const syncIntervalMinutes =
        config.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES;
      return {
        id: c.id,
        sourceSystem: c.sourceSystem,
        name: c.name,
        status: c.status,
        syncIntervalMinutes,
        backfillSince: config.backfillSince ?? null,
        backfillCompletedAt: c.backfillCompletedAt,
        lastSyncAt: c.lastSyncAt,
        nextSyncDueAt: c.lastSyncAt
          ? new Date(c.lastSyncAt.getTime() + syncIntervalMinutes * 60_000)
          : new Date(now),
        eventsIngested: stats?._count.id ?? 0,
        earliestEventAt: stats?._min.occurredAt ?? null,
        latestEventAt: stats?._max.occurredAt ?? null,
        rateLimitedUntil,
        lastError: c.lastError,
        lastErrorAt: c.lastErrorAt,
      };
    });

    const itemsBySource = new Map<string, ConnectionSyncStatus[]>();
    for (const item of items) {
      const list = itemsBySource.get(item.sourceSystem) ?? [];
      list.push(item);
      itemsBySource.set(item.sourceSystem, list);
    }
    const tickBySource = new Map(ticks.map((t) => [t.sourceSystem, t]));

    const sources: SourceSyncStatus[] = SCHEDULED_SOURCE_SYSTEMS.map(
      (sourceSystem, idx) => {
        const sourceItems = itemsBySource.get(sourceSystem) ?? [];
        const tick = tickBySource.get(sourceSystem);
        const tickRunning = Boolean(
          tick?.startedAt &&
          (!tick.finishedAt || tick.finishedAt < tick.startedAt),
        );
        let etaSeconds: number | null = null;
        if (tickRunning && tick?.startedAt && tick.connectionsProcessed > 0) {
          const elapsedMs = now - tick.startedAt.getTime();
          const avgMsPerConnection = elapsedMs / tick.connectionsProcessed;
          const remaining = tick.totalConnections - tick.connectionsProcessed;
          etaSeconds = Math.max(
            0,
            Math.round((remaining * avgMsPerConnection) / 1000),
          );
        }

        const completedRuns = sourceItems
          .filter(
            (i): i is ConnectionSyncStatus & { backfillCompletedAt: Date } =>
              Boolean(i.backfillCompletedAt),
          )
          .sort(
            (a, b) =>
              b.backfillCompletedAt.getTime() - a.backfillCompletedAt.getTime(),
          );
        const inProgress = sourceItems.filter(
          (i) => !i.backfillCompletedAt && i.status === 'active',
        );

        const history: SyncRunHistoryEntry[] = historyBySource[idx].map(
          (run) => ({
            id: run.id,
            connectionId: run.connectionId,
            connectionName:
              nameByConn.get(run.connectionId) ?? run.connectionId,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            eventsFetched: run.eventsFetched,
            eventsIngested: run.eventsIngested,
            status: run.status,
            errorMessage: run.errorMessage,
          }),
        );

        return {
          sourceSystem,
          tick: {
            running: tickRunning,
            startedAt: tick?.startedAt ?? null,
            finishedAt: tick?.finishedAt ?? null,
            totalConnections: tick?.totalConnections ?? 0,
            connectionsProcessed: tick?.connectionsProcessed ?? 0,
            etaSeconds,
          },
          inProgress,
          completedRuns,
          history,
        };
      },
    );

    return {
      summary: {
        totalConnections: items.length,
        backfillComplete: items.filter((i) => i.backfillCompletedAt).length,
        backfillInProgress: items.filter((i) => !i.backfillCompletedAt).length,
        totalEventsIngested: items.reduce(
          (sum, i) => sum + i.eventsIngested,
          0,
        ),
        failing: items
          .filter((i) => i.lastError)
          .map((i) => ({
            sourceSystem: i.sourceSystem,
            name: i.name,
            error: i.lastError as string,
            lastErrorAt: i.lastErrorAt,
          })),
        rateLimited: items.filter((i) => i.rateLimitedUntil).length,
      },
      sources,
    };
  }

  /** Replaces the connection's cursor state — the collector owns cursor shape/keys. */
  async setSyncCursors(
    id: string,
    cursors: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.connection.update({
      where: { id },
      data: { syncCursors: cursors as Prisma.InputJsonValue },
    });
  }

  /**
   * Re-opens a connection's history: moves its backfill floor back and clears
   * the cursors so the next poll walks from the new floor instead of resuming
   * where it left off.
   *
   * Both halves are required. `backfillSince` alone changes nothing, because
   * every collector checks its cursor first — GitHub goes straight to
   * incremental mode once `prBackfillDone` is set, and Jira's `updatedCursor`
   * overrides the floor entirely. Clearing cursors alone would re-walk only as
   * far as the existing floor.
   *
   * Safe to run against a populated database: no row is deleted. Every write
   * path downstream is keyed on a natural identity — stories on
   * `(tenant, externalKey)`, commits on `(tenant, repo, sha)`, PRs on
   * `(tenant, repo, number)`, all upserts — and the append-only tables dedupe
   * on the source's own stable ids (`changelogId` for transitions, the review
   * id for reviews). Re-collected records update in place; already-seen events
   * are dropped by the ingestion idempotency key.
   */
  async reopenBackfill(id: string, since: Date): Promise<void> {
    const connection = await this.prisma.connection.findUnique({
      where: { id },
      select: { config: true },
    });
    if (!connection) {
      return;
    }
    await this.prisma.connection.update({
      where: { id },
      data: {
        config: {
          ...((connection.config as Record<string, unknown> | null) ?? {}),
          backfillSince: since.toISOString(),
        } as Prisma.InputJsonValue,
        syncCursors: {} as Prisma.InputJsonValue,
        // The connection is walking history again, so it is no longer "fully
        // backfilled" — leaving this set would tell the sweep scheduler this
        // connection needs no priority, exactly when it needs the most.
        backfillCompletedAt: null,
      },
    });
  }

  /** Every connection for a tenant, optionally narrowed to one source system. */
  async listForTenant(
    tenantId: string,
    sourceSystem?: string,
  ): Promise<Connection[]> {
    return this.prisma.connection.findMany({
      where: {
        tenantId,
        ...(sourceSystem ? { sourceSystem } : {}),
      },
      orderBy: { name: 'asc' },
    });
  }

  /** Replaces the connection's rate-limit state; `{}` clears an expired cooldown. */
  async setRateLimitState(
    id: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.connection.update({
      where: { id },
      data: { rateLimitState: state as Prisma.InputJsonValue },
    });
  }

  /**
   * Records whether the last sync pass actually succeeded against the source.
   *
   * A pass that reached the source and was rejected still returns zero events,
   * which reads identically to "nothing changed" — so this is what stops a
   * connection with a revoked token from reporting healthy indefinitely.
   * Passing `null` clears it, so a connection recovers on its next clean pass
   * rather than wearing a stale error.
   */
  async setSyncHealth(id: string, error: string | null): Promise<void> {
    await this.prisma.connection.update({
      where: { id },
      data: {
        lastError: error ? error.slice(0, 500) : null,
        lastErrorAt: error ? new Date() : null,
      },
    });
  }

  /** Updates the connection's identity/credentials (config, secret refs, status) in one write. */
  async updateConfig(
    id: string,
    input: {
      config: Record<string, unknown>;
      secretRef?: string;
      webhookSecretRef?: string;
      status: string;
    },
  ): Promise<void> {
    await this.prisma.connection.update({
      where: { id },
      data: {
        config: input.config as Prisma.InputJsonValue,
        secretRef: input.secretRef,
        webhookSecretRef: input.webhookSecretRef,
        status: input.status,
      },
    });
  }

  async setStatus(id: string, status: string): Promise<void> {
    await this.prisma.connection.update({ where: { id }, data: { status } });
  }
}
