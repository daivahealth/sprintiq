import { Injectable } from '@nestjs/common';

/**
 * BC-11/12 AI Agent Orchestration + Knowledge/Memory. Shared agent runtime
 * (router → RAG context → reason loop → guardrails → memory) and the persona
 * agents. AI is tool-grounded and cited — LLMs never originate metrics.
 * See docs/features/AI-AGENTS.md. (Scaffold stub.)
 */
@Injectable()
export class AiAgentsService {}
