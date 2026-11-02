import {
  isValidTriStateFlagValue,
  parseTriStateFlag,
} from '../../config/env-flags';

/**
 * Deployment knobs for the in-memory knowledge graph, parsed in one place so
 * the boot-time validator (`config/env.validation.ts`) and the graph manager
 * can never disagree about what a value means.
 */
export interface KnowledgeGraphConfig {
  /** `KNOWLEDGE_GRAPH_ENABLED` — on unless explicitly turned off. */
  enabled: boolean;
  /** `KNOWLEDGE_GRAPH_WINDOW_DAYS` — how much history is held in memory. */
  windowDays: number;
  /** `KNOWLEDGE_GRAPH_REBUILD_MINUTES` — full rebuild cadence. */
  rebuildMinutes: number;
}

export const DEFAULT_WINDOW_DAYS = 90;
export const MAX_WINDOW_DAYS = 730;
export const DEFAULT_REBUILD_MINUTES = 30;
export const MIN_REBUILD_MINUTES = 5;
export const MAX_REBUILD_MINUTES = 24 * 60;

export function readKnowledgeGraphConfig(
  env: Record<string, unknown> = process.env,
): KnowledgeGraphConfig {
  const rawEnabled = env.KNOWLEDGE_GRAPH_ENABLED;
  if (
    rawEnabled !== undefined &&
    (typeof rawEnabled !== 'string' ||
      (rawEnabled.trim() !== '' && !isValidTriStateFlagValue(rawEnabled)))
  ) {
    throw new Error(
      `Invalid KNOWLEDGE_GRAPH_ENABLED "${String(rawEnabled)}". Expected one of: on | off | true | false | 1 | 0, or unset (on).`,
    );
  }
  // Unset is on: the graph only reads what Postgres already holds and serves
  // admin-only routes, and a POC nobody can reach without a flag gets no use.
  const enabled =
    parseTriStateFlag(
      'KNOWLEDGE_GRAPH_ENABLED',
      rawEnabled as string | undefined,
    ) ?? true;

  return {
    enabled,
    windowDays: readInt(
      env,
      'KNOWLEDGE_GRAPH_WINDOW_DAYS',
      DEFAULT_WINDOW_DAYS,
      1,
      MAX_WINDOW_DAYS,
    ),
    rebuildMinutes: readInt(
      env,
      'KNOWLEDGE_GRAPH_REBUILD_MINUTES',
      DEFAULT_REBUILD_MINUTES,
      MIN_REBUILD_MINUTES,
      MAX_REBUILD_MINUTES,
    ),
  };
}

function readInt(
  env: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Invalid ${name} "${String(raw)}". Expected an integer from ${min} to ${max}.`,
    );
  }
  return parsed;
}
