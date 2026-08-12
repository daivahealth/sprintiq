import { Module } from '@nestjs/common';
import { CorrelationModule } from '../../correlation/correlation.module';
import { MetricsModule } from '../../metrics/metrics.module';
import { CodeModule } from '../code/code.module';
import { ConnectionsModule } from '../connections/connections.module';
import { PlanningModule } from '../planning/planning.module';
import { CatalogController } from './catalog.controller';
import { DashboardsController } from './dashboards.controller';
import { DashboardsService } from './dashboards.service';
import { InsightsController } from './insights.controller';

/** BC-13 Dashboards & Reporting (read-model / BFF) + entity catalogs. */
@Module({
  imports: [
    MetricsModule,
    CodeModule,
    PlanningModule,
    CorrelationModule,
    // Read-only: the freshness endpoint reports collector/connection state.
    // BC-13 never calls a source API itself (api/README.md §0).
    ConnectionsModule,
  ],
  controllers: [DashboardsController, CatalogController, InsightsController],
  providers: [DashboardsService],
  exports: [DashboardsService],
})
export class DashboardsModule {}
