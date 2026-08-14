import { Module } from '@nestjs/common';
import { PlanningModule } from '../modules/planning/planning.module';
import { CorrelationSchedulerService } from './correlation-scheduler.service';
import { CorrelationService } from './correlation.service';
import { DeveloperIdentityService } from './developer-identity.service';

/** BC-5 Correlation & Delivery Graph. */
@Module({
  imports: [PlanningModule],
  providers: [
    CorrelationService,
    CorrelationSchedulerService,
    DeveloperIdentityService,
  ],
  exports: [CorrelationService, DeveloperIdentityService],
})
export class CorrelationModule {}
