import { Module } from '@nestjs/common';
import { MetricsModule } from '../../metrics/metrics.module';
import { DashboardsController } from './dashboards.controller';
import { DashboardsService } from './dashboards.service';

/** BC-13 Dashboards & Reporting (read-model / BFF). */
@Module({
  imports: [MetricsModule],
  controllers: [DashboardsController],
  providers: [DashboardsService],
  exports: [DashboardsService],
})
export class DashboardsModule {}
