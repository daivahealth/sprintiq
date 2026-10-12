/**
 * Every tunable of the GitHub audit-log sync, parsed in ONE place (spec §4.7).
 * Invalid values throw — `validateEnv` calls this at boot, so a typo fails the
 * deploy instead of silently running at a default the operator didn't choose.
 */
export type GithubAuditMode = 'off' | 'shadow' | 'ingest';

export const ALLOWED_AUDIT_INTERVALS = [5, 10, 15, 20, 30, 60] as const;

/** Full branch sweep cadence in minutes; 0 turns the sweep off (spec item 3). */
export const ALLOWED_FULL_SWEEP_INTERVALS = [0, 30, 60, 120, 240] as const;

export interface GithubAuditConfig {
  mode: GithubAuditMode;
  intervalMinutes: number;
  pageSize: number;
  overlapMinutes: number;
  compareConcurrency: number;
  maxRangeAttempts: number;
  maxPages: number;
  /** A pre-run checkpoint older than this is reported as a lag warning in `run.error` (spec item 2). */
  lagWarnMinutes: number;
  /**
   * How often the full branch sweep lists every registered repo's branches,
   * the backstop for pushes the audit log never records (spec item 3). 0 = off.
   */
  fullSweepMinutes: number;
}

function intIn(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(
      `Invalid ${name} "${raw}". Expected an integer ${min}–${max}.`,
    );
  }
  return n;
}

export function readGithubAuditConfig(
  env: NodeJS.ProcessEnv = process.env,
): GithubAuditConfig {
  const rawMode = (env.GITHUB_AUDIT_SYNC_MODE ?? '').trim().toLowerCase();
  const mode = (rawMode === '' ? 'off' : rawMode) as GithubAuditMode;
  if (!['off', 'shadow', 'ingest'].includes(mode)) {
    throw new Error(
      `Invalid GITHUB_AUDIT_SYNC_MODE "${env.GITHUB_AUDIT_SYNC_MODE}". Expected off | shadow | ingest.`,
    );
  }
  const intervalMinutes = intIn(
    env,
    'GITHUB_AUDIT_SYNC_INTERVAL_MINUTES',
    5,
    1,
    60,
  );
  if (
    !(ALLOWED_AUDIT_INTERVALS as readonly number[]).includes(intervalMinutes)
  ) {
    throw new Error(
      `Invalid GITHUB_AUDIT_SYNC_INTERVAL_MINUTES "${intervalMinutes}". Expected one of ${ALLOWED_AUDIT_INTERVALS.join(', ')}.`,
    );
  }
  const fullSweepMinutes = intIn(
    env,
    'GITHUB_AUDIT_FULL_SWEEP_MINUTES',
    60,
    0,
    240,
  );
  if (
    !(ALLOWED_FULL_SWEEP_INTERVALS as readonly number[]).includes(
      fullSweepMinutes,
    )
  ) {
    throw new Error(
      `Invalid GITHUB_AUDIT_FULL_SWEEP_MINUTES "${fullSweepMinutes}". Expected one of ${ALLOWED_FULL_SWEEP_INTERVALS.join(', ')} (0 = off).`,
    );
  }
  return {
    mode,
    intervalMinutes,
    fullSweepMinutes,
    pageSize: intIn(env, 'GITHUB_AUDIT_PAGE_SIZE', 100, 1, 100),
    overlapMinutes: intIn(env, 'GITHUB_AUDIT_OVERLAP_MINUTES', 15, 0, 120),
    compareConcurrency: intIn(env, 'GITHUB_AUDIT_COMPARE_CONCURRENCY', 2, 1, 8),
    maxRangeAttempts: intIn(env, 'GITHUB_AUDIT_MAX_RANGE_ATTEMPTS', 5, 1, 20),
    maxPages: intIn(env, 'GITHUB_AUDIT_MAX_PAGES', 200, 1, 1000),
    lagWarnMinutes: intIn(env, 'GITHUB_AUDIT_LAG_WARN_MINUTES', 30, 5, 1440),
  };
}

/** Six-field (seconds-first) cron, as `@nestjs/schedule` accepts. 60 ⇒ top of every hour. */
export function auditCronExpression(intervalMinutes: number): string {
  return intervalMinutes === 60
    ? '0 0 * * * *'
    : `0 */${intervalMinutes} * * * *`;
}

/**
 * Cron for the full branch sweep. 120/240 run on the hour every 2/4 hours.
 * 0 (off) still yields a valid hourly expression because the decorator needs
 * one at module load — `sweepTick` itself returns immediately when off.
 */
export function fullSweepCronExpression(sweepMinutes: number): string {
  if (sweepMinutes === 120 || sweepMinutes === 240) {
    return `0 0 */${sweepMinutes / 60} * * *`;
  }
  return auditCronExpression(sweepMinutes === 30 ? 30 : 60);
}
