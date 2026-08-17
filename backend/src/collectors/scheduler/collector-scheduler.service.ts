import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Connection } from '@prisma/client';
import { newId } from '../../common/id';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { PrismaService } from '../../database/prisma.service';
import {
  DEFAULT_SYNC_INTERVAL_MINUTES,
  SourceSystem,
} from '../../modules/connections/connection.types';
import { ConnectionsService } from '../../modules/connections/connections.service';
import { CollectorRegistry } from '../framework/collector.registry';
import { PollOptions, PollSkipReason } from '../framework/source-collector';
import { IngestionService } from '../ingestion/ingestion.service';

/**
 * Scheduled sync sweep (BC-1, M17 Scheduler). GitHub and Jira are ticked on
 * INDEPENDENT crons so one source's cadence never blocks or couples to the
 * other's — each connection carries its own `config.syncIntervalMinutes`
 * (admin-configurable per source, default 4h/240min via
 * DEFAULT_SYNC_INTERVAL_MINUTES) and is only actually polled once that
 * interval has elapsed since its last sync. The tick itself runs often
 * (every 5 min) purely as a cheap due-check — that cadence is NOT the sync
 * interval, it just bounds how late a due connection can start.
 *
 * Tracks tick start/finish/progress per source in a persisted `SchedulerTick`
 * row (not in-memory — the dev server restarts frequently, and this must
 * survive that, plus work the same across multiple API replicas) so the Sync
 * Status screen can show whether a given source's sweep is running right now
 * and a rough ETA. Also records one tenant-scoped `ConnectionSyncRun` per
 * connection actually synced this tick (skipped/not-due connections get no
 * row) — this is the "previous sync + what was synced" history.
 */
/**
 * How long an unfinished sweep blocks the next one. Long enough that a genuine
 * org-scale pass (hundreds of connections, rate-limit pauses) is never cut off
 * by a second sweep; short enough that a process killed mid-sweep resumes
 * within the hour rather than stranding the source permanently.
 */
const SWEEP_STALE_AFTER_MS = 45 * 60_000;

/**
 * The dashboards bucket on IST calendar days (DASHBOARDS.md §4.1.1), so the
 * day the collection deadline refers to has to be the same one — hardcoded for
 * the same reason `common/time.ts` hardcodes the offset.
 */
const IST_TIMEZONE = 'Asia/Kolkata';

/**
 * Hour (IST) at which the day-close pass runs. Default 22:00 — late enough to
 * capture the working day, with roughly two hours of headroom for an org-scale
 * sweep to actually finish before the date rolls over. Tunable per deployment,
 * since how long a sweep takes depends on how many connections it runs.
 */
const DAY_CLOSE_HOUR_IST = (() => {
  const raw = Number(process.env.DAY_CLOSE_HOUR_IST);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 22;
})();

/**
 * How many connections one sweep polls at once. Deliberately small: the point
 * is to stop wall-clock being the binding constraint on a 195-connection
 * fleet, not to maximise throughput — API spend is bounded by the collector's
 * per-sweep budget, and every connection still writes its own rows.
 */
const SWEEP_CONCURRENCY = (() => {
  const raw = Number(process.env.COLLECTOR_SWEEP_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 4;
})();

/** Human-readable reason stored on the skipped `ConnectionSyncRun`. */
const SKIP_REASONS: Record<PollSkipReason, string> = {
  'rate-limited':
    'Skipped — the connection was still in a rate-limit cooldown, so this pass never called the source.',
  'no-credential':
    'Skipped — no credential resolved for this connection, so this pass never called the source.',
  'not-configured':
    'Skipped — the connection is missing required config (repository / site), so this pass never called the source.',
};

@Injectable()
export class CollectorSchedulerService {
  private readonly logger = new Logger(CollectorSchedulerService.name);

  constructor(
    private readonly connections: ConnectionsService,
    private readonly registry: CollectorRegistry,
    private readonly ingestion: IngestionService,
    private readonly tenantContext: TenantContextService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * The day-close pass: queue **every** active connection so the IST calendar
   * day ends with its own work collected.
   *
   * Nothing else in this scheduler knows what a day is. `isDue` is a rolling
   * interval, so a repo polled at 21:00 on the 4-hour default is not polled
   * again until 01:00 — its entire evening lands in *tomorrow's* data, and a
   * board asking "what shipped today?" answers wrong every night. No interval
   * setting fixes that; only anchoring a pass to the boundary does.
   *
   * It queues (`syncRequestedAt`) rather than sweeping inline, for the same
   * reason `sync-now` does: the ordinary 5-minute tick then collects them
   * under the existing single-sweep guard, instead of a second concurrent pass
   * spending the rate limit on connections the first is already walking.
   *
   * The honest bound: this makes the day complete **through the close hour**,
   * not through midnight. Work after it is collected by the next day's first
   * sweep. Closing at midnight itself would be worse — an org-scale sweep runs
   * for tens of minutes, so it would finish inside the following day.
   */
  @Cron(`0 ${DAY_CLOSE_HOUR_IST} * * *`, { timeZone: IST_TIMEZONE })
  async closeOutTheDay(): Promise<void> {
    const queued = await this.connections.requestSyncForAllActive();
    this.logger.log(
      `IST day close (${DAY_CLOSE_HOUR_IST}:00): queued ${queued} active connection(s) so today's data is collected before the day ends.`,
    );
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tickGithub(): Promise<void> {
    await this.tick('github');
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tickJira(): Promise<void> {
    await this.tick('jira');
  }

  private async tick(sourceSystem: SourceSystem): Promise<void> {
    // A sweep already running is not a reason to start another. The cron fires
    // on a fixed cadence regardless of how long the previous run took, and a
    // sweep over an org-scale connection list (one per repo) takes far longer
    // than the cadence. Overlapping sweeps both start at the head of the list,
    // so they spend the rate limit re-polling the same connections while the
    // tail is never reached — the failure the ordering in
    // `findActiveBySource` is the other half of.
    if (await this.isSweepRunning(sourceSystem)) {
      this.logger.log(
        `${sourceSystem} sweep still running — skipping this tick rather than starting a second pass over the same connections.`,
      );
      return;
    }

    const all = await this.connections.findActiveBySource(sourceSystem);
    const now = Date.now();
    const due = all.filter((c) => this.isDue(c, now));

    await this.prisma.schedulerTick.upsert({
      where: { sourceSystem },
      create: {
        sourceSystem,
        startedAt: new Date(),
        finishedAt: null,
        totalConnections: due.length,
        connectionsProcessed: 0,
      },
      update: {
        startedAt: new Date(),
        finishedAt: null,
        totalConnections: due.length,
        connectionsProcessed: 0,
      },
    });

    // How many due connections share a credential this sweep. The collector
    // divides its fleet budget by this, so a 195-repo tenant spends the same
    // quota per sweep as a 2-repo one instead of 100× more.
    //
    // Keyed on tenant AND secret ref, because the rate limit belongs to the
    // TOKEN, not the tenant. Grouping on tenant alone under-divided whenever
    // one tenant held several credentials — each group would claim a full
    // budget against a limit it actually shares. The tenant stays in the key
    // because `SecretsService` resolves a ref per tenant first, so the same
    // ref name in two tenants is usually two different tokens.
    const dueByCredential = new Map<string, number>();
    const credentialKey = (c: Connection) =>
      `${c.tenantId}:${c.secretRef ?? ''}`;
    for (const connection of due) {
      const key = credentialKey(connection);
      dueByCredential.set(key, (dueByCredential.get(key) ?? 0) + 1);
    }

    try {
      await this.forEachBounded(due, SWEEP_CONCURRENCY, async (connection) => {
        await this.syncOne(connection, {
          peersDue: dueByCredential.get(credentialKey(connection)) ?? 1,
        });
        await this.prisma.schedulerTick.update({
          where: { sourceSystem },
          data: { connectionsProcessed: { increment: 1 } },
        });
      });
    } finally {
      // Always close the sweep out. `syncOne` swallows collector errors, but
      // anything escaping it (a DB blip mid-loop) would otherwise leave the
      // row open and — now that an open row blocks the next tick — stall the
      // source until the staleness bound expires.
      await this.prisma.schedulerTick.update({
        where: { sourceSystem },
        data: { finishedAt: new Date() },
      });
    }
  }

  /**
   * Runs `fn` over `items` with at most `limit` in flight.
   *
   * A serial sweep of 195 connections runs for tens of minutes, so wall-clock —
   * not the API budget — became what bounded how often any one connection was
   * reached. Overlapping a few is safe *because* spend is now governed by the
   * shared per-sweep budget rather than by how many run at once; doing this
   * before that change would simply have hit the rate limit faster.
   *
   * `allSettled`, not `all`: `all` rejects on the first failure while the other
   * workers are still running, so the caller's `finally` would stamp the sweep
   * finished with connections still mid-flight. Every worker is drained first,
   * then the first real error is rethrown so it still propagates.
   */
  private async forEachBounded<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    let next = 0;
    let firstError: unknown;
    // Safe without a lock: the read-and-increment is synchronous, and JS runs
    // it to completion before any other worker resumes.
    const worker = async (): Promise<void> => {
      while (next < items.length) {
        try {
          await fn(items[next++]);
        } catch (err) {
          // Caught per ITEM, not per worker. Letting it escape the loop would
          // stop this worker consuming at all, so a handful of transient DB
          // errors would silently abandon every remaining connection while the
          // caller's `finally` still stamped the sweep finished. One bad item
          // must cost one item.
          firstError ??= err;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, worker),
    );
    // Every worker has drained before this point, so the caller's `finally`
    // can close the sweep out knowing nothing is still in flight.
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  /**
   * Is a sweep for this source already in flight?
   *
   * `startedAt` set with no `finishedAt` means a run began and hasn't closed
   * out. The staleness bound matters: a process killed mid-sweep leaves that
   * row open forever, and without an expiry the source would never sync again
   * — a far worse failure than the duplicate pass this guards against.
   */
  private async isSweepRunning(sourceSystem: SourceSystem): Promise<boolean> {
    const tick = await this.prisma.schedulerTick.findUnique({
      where: { sourceSystem },
    });
    if (!tick?.startedAt || tick.finishedAt) {
      return false;
    }
    return Date.now() - tick.startedAt.getTime() < SWEEP_STALE_AFTER_MS;
  }

  /**
   * No prior sync, or backfill still in progress → always due. The configured
   * interval only throttles STEADY-STATE incremental polling (post-backfill);
   * gating the initial backfill walk on it too would strand a large/rate-
   * limited history at one poll attempt per interval instead of one per tick,
   * making backfill take far longer than the bounded per-tick page budget
   * (§3) was designed for.
   */
  private isDue(connection: Connection, now: number): boolean {
    // An admin asked for this one explicitly. Honouring the interval here
    // would turn "sync now" into "within four hours".
    if (connection.syncRequestedAt) {
      return true;
    }
    if (!connection.lastSyncAt || !connection.backfillCompletedAt) {
      return true;
    }
    const config = (connection.config ?? {}) as {
      syncIntervalMinutes?: number;
    };
    const intervalMs =
      (config.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES) * 60_000;
    return connection.lastSyncAt.getTime() + intervalMs <= now;
  }

  private async syncOne(
    connection: Connection,
    options: PollOptions,
  ): Promise<void> {
    const collector = this.registry.get(connection.sourceSystem);
    if (!collector) {
      return;
    }
    // Entered PER CONNECTION, never once around the sweep. With connections
    // running concurrently this is what keeps one tenant's events from being
    // ingested under another's id — `runWithTenant` is async-local storage, so
    // each in-flight branch carries its own.
    await this.tenantContext.runWithTenant(connection.tenantId, async () => {
      const run = await this.prisma.connectionSyncRun.create({
        data: {
          id: newId(),
          tenantId: connection.tenantId,
          connectionId: connection.id,
          sourceSystem: connection.sourceSystem,
          startedAt: new Date(),
          status: 'running',
        },
      });
      try {
        const { envelopes, skipped, failed, collectedThroughAt } =
          await collector.poll(connection, options);

        // A pass that never reached the source did not sync this connection.
        // Recording it as one would stamp `lastSyncAt` — reporting the
        // connection as fresh on every dashboard while its data stood still,
        // and dropping it to the back of the neediest-first sweep queue at
        // precisely the moment it needs to be at the front.
        if (skipped) {
          await this.prisma.connectionSyncRun.update({
            where: { id: run.id },
            data: {
              finishedAt: new Date(),
              status: 'skipped',
              errorMessage: SKIP_REASONS[skipped],
            },
          });
          return;
        }

        let ingested = 0;
        for (const envelope of envelopes) {
          const result = await this.ingestion.ingest(
            connection.tenantId,
            envelope,
          );
          if (result.status === 'accepted') {
            ingested++;
          }
        }
        // A pass the source REFUSED is not a sync, even though it reached the
        // source and may have collected something before the refusal. Its
        // envelopes are kept (above — real data), but `touchSync` is withheld:
        // stamping `lastSyncAt` here would report the connection freshly
        // synced on every dashboard and sink it in the neediest-first queue,
        // which is the same defect the `skipped` path exists to prevent.
        if (!failed) {
          await this.connections.touchSync(connection.id);
          // Only when the pass actually established one. Mid-backfill passes
          // report none, and writing "now" for them would claim a completeness
          // the collector never reached.
          if (collectedThroughAt) {
            await this.connections.setCollectedThroughAt(
              connection.id,
              collectedThroughAt,
            );
          }
        }
        await this.prisma.connectionSyncRun.update({
          where: { id: run.id },
          data: {
            finishedAt: new Date(),
            eventsFetched: envelopes.length,
            eventsIngested: ingested,
            status: failed ? 'error' : 'success',
            ...(failed
              ? {
                  errorMessage:
                    'The source rejected this pass — see the connection health for the specific reason.',
                }
              : {}),
          },
        });
        if (envelopes.length > 0) {
          this.logger.log(
            `synced ${connection.sourceSystem}:${connection.name} — ${ingested}/${envelopes.length} new`,
          );
        }
      } catch (err) {
        // One connection's failure must never abort the sweep for the rest.
        this.logger.error(
          `sync failed for connection ${connection.id} (${connection.sourceSystem}): ${(err as Error).message}`,
        );
        await this.prisma.connectionSyncRun.update({
          where: { id: run.id },
          data: {
            finishedAt: new Date(),
            status: 'error',
            errorMessage: (err as Error).message.slice(0, 500),
          },
        });
      }
    });
  }
}
