import { Module } from '@nestjs/common';
import { CorrelationModule } from '../correlation/correlation.module';
import { CodeModule } from '../modules/code/code.module';
import { ConnectionsModule } from '../modules/connections/connections.module';
import { PlanningModule } from '../modules/planning/planning.module';
import { DeveloperActivityService } from './developer-activity.service';
import { InsightsService } from './insights.service';
import { MetricsService } from './metrics.service';

/** BC-8 Metrics & Aggregation Engine + dashboard insight read models. */
@Module({
  // ConnectionsModule: the velocity read needs the collection horizon, which
  // is a property of the connections, to know which sprints predate the data.
  imports: [CodeModule, ConnectionsModule, CorrelationModule, PlanningModule],
  providers: [MetricsService, InsightsService, DeveloperActivityService],
  exports: [MetricsService, InsightsService, DeveloperActivityService],
})
export class MetricsModule {}
