import { Module } from '@nestjs/common';
import { PlanningService } from './planning.service';

/** BC-3 Planning & Work Management (Jira domain). */
@Module({
  providers: [PlanningService],
  exports: [PlanningService],
})
export class PlanningModule {}
