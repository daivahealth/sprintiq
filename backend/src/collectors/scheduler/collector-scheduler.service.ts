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

    try {
      for (const connection of due) {
        await this.syncOne(connection);
        await this.prisma.schedulerTick.update({
          where: { sourceSystem },
          data: { connectionsProcessed: { increment: 1 } },
        });
      }
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

  private async syncOne(connection: Connection): Promise<void> {
    const collector = this.registry.get(connection.sourceSystem);
    if (!collector) {
      return;
    }
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
        const envelopes = await collector.poll(connection);
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
        await this.connections.touchSync(connection.id);
        await this.prisma.connectionSyncRun.update({
          where: { id: run.id },
          data: {
            finishedAt: new Date(),
            eventsFetched: envelopes.length,
            eventsIngested: ingested,
            status: 'success',
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
