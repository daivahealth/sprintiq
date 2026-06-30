import { Injectable } from '@nestjs/common';

/**
 * BC-9 Rule & Risk Engine. Evaluates configurable rules over metrics/graph/events
 * and emits findings = Risk + Severity + Evidence + Recommendation + Owner.
 * See docs/features/RULES.md. (Scaffold stub.)
 */
@Injectable()
export class RulesService {}
