import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Connection } from '@prisma/client';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { ConnectionsService } from '../../modules/connections/connections.service';
import { CollectorRegistry } from '../framework/collector.registry';
import { IngestionService } from '../ingestion/ingestion.service';

/**
 * Scheduled sync sweep (BC-1, M17 Scheduler). Every tick, polls each active
 * connection through its source collector. A single `collector.poll()` call
 * owns pagination, rate-limit backoff, and cursor persistence — backfilling
 * history on first runs, then reconciling incrementally — so this service only
 * fans out per connection and ingests whatever comes back, in that
 * connection's own tenant context (docs/api/README.md §3).
 */
@Injectable()
export class CollectorSchedulerService {
  private readonly logger = new Logger(CollectorSchedulerService.name);

  constructor(
    private readonly connections: ConnectionsService,
    private readonly registry: CollectorRegistry,
    private readonly ingestion: IngestionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async syncAll(): Promise<void> {
    const connections = await this.connections.listActive();
    for (const connection of connections) {
      await this.syncOne(connection);
    }
  }

  private async syncOne(connection: Connection): Promise<void> {
    const collector = this.registry.get(connection.sourceSystem);
    if (!collector) {
      return;
    }
    await this.tenantContext.runWithTenant(connection.tenantId, async () => {
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
      }
    });
  }
}
