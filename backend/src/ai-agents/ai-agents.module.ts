import { Module } from '@nestjs/common';
import { AiAgentsService } from './ai-agents.service';

/** BC-11/12 AI Agent Orchestration + Knowledge & Memory. */
@Module({
  providers: [AiAgentsService],
  exports: [AiAgentsService],
})
export class AiAgentsModule {}
