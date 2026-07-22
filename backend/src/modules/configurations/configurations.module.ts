import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { ConfigurationsController } from './configurations.controller';
import { ConfigurationsService } from './configurations.service';

/**
 * Tenant-scoped admin configuration for integrations, AI, metrics, and policy.
 * Imports ConnectionsModule to bridge github/jira config into a real BC-0
 * Connection so collection can actually run (see ConfigurationsService).
 */
@Module({
  imports: [ConnectionsModule],
  controllers: [ConfigurationsController],
  providers: [ConfigurationsService],
  exports: [ConfigurationsService],
})
export class ConfigurationsModule {}
