import { Module } from '@nestjs/common';
import { PlanningModule } from '../modules/planning/planning.module';
import { CorrelationSchedulerService } from './correlation-scheduler.service';
import { CorrelationService } from './correlation.service';

/** BC-5 Correlation & Delivery Graph. */
@Module({
  imports: [PlanningModule],
  providers: [CorrelationService, CorrelationSchedulerService],
  exports: [CorrelationService],
})
export class CorrelationModule {}
