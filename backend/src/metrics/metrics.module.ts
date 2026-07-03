import { Module } from '@nestjs/common';
import { CorrelationModule } from '../correlation/correlation.module';
import { CodeModule } from '../modules/code/code.module';
import { PlanningModule } from '../modules/planning/planning.module';
import { InsightsService } from './insights.service';
import { MetricsService } from './metrics.service';

/** BC-8 Metrics & Aggregation Engine + dashboard insight read models. */
@Module({
  imports: [CodeModule, CorrelationModule, PlanningModule],
  providers: [MetricsService, InsightsService],
  exports: [MetricsService, InsightsService],
})
export class MetricsModule {}
