import { Module } from '@nestjs/common';
import { CollectorsModule } from '../../collectors/collectors.module';
import { CorrelationModule } from '../../correlation/correlation.module';
import { ConnectionsModule } from '../connections/connections.module';
import { ConfigurationsController } from './configurations.controller';
import { ConfigurationsService } from './configurations.service';

/**
 * Tenant-scoped admin configuration for integrations, AI, metrics, and policy.
 * Imports ConnectionsModule to bridge github/jira config into a real BC-0
 * Connection so collection can actually run (see ConfigurationsService),
 * CollectorsModule for the org-wide GitHub repo-discovery sync + stats
 * reconcilers, and CorrelationModule for the orphan-reconciliation sweep.
 */
@Module({
  imports: [ConnectionsModule, CollectorsModule, CorrelationModule],
  controllers: [ConfigurationsController],
  providers: [ConfigurationsService],
  exports: [ConfigurationsService],
})
export class ConfigurationsModule {}
