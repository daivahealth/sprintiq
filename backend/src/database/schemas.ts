/**
 * One PostgreSQL schema per bounded context (ADR-0004). A context's tables live
 * in its own schema so they can be lifted to a separate database on extraction,
 * and so cross-context joins are deliberate, not accidental.
 *
 * Entities set `{ schema: Schema.X }` in their @Entity() decorator.
 */
export const Schema = {
  IDENTITY: 'identity',
  CONNECTIONS: 'connections',
  COLLECTORS: 'collectors',
  PLANNING: 'planning',
  CODE: 'code',
  CI: 'ci',
  QUALITY: 'quality',
  CORRELATION: 'correlation',
  METRICS: 'metrics',
  RULES: 'rules',
  ANALYTICS: 'analytics',
  AI_AGENTS: 'ai_agents',
  DASHBOARDS: 'dashboards',
  NOTIFICATIONS: 'notifications',
  AUDIT: 'audit',
} as const;

export type SchemaName = (typeof Schema)[keyof typeof Schema];

export const ALL_SCHEMAS: SchemaName[] = Object.values(Schema);
