/**
 * Every tunable of the GitHub audit-log sync, parsed in ONE place (spec §4.7).
 * Invalid values throw — `validateEnv` calls this at boot, so a typo fails the
 * deploy instead of silently running at a default the operator didn't choose.
 */
export type GithubAuditMode = 'off' | 'shadow' | 'ingest';

export const ALLOWED_AUDIT_INTERVALS = [5, 10, 15, 20, 30, 60] as const;

/** Full branch sweep cadence in minutes; 0 turns the sweep off (spec item 3). */
export const ALLOWED_FULL_SWEEP_INTERVALS = [0, 30, 60, 120, 240] as const;

/** Hours between scheduled whole-org repo syncs. 0 = off (manual only). */
export const ALLOWED_ORG_SYNC_HOURS = [0, 6, 12, 24] as const;

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
  /**
   * An auto-registered repo (spec item 4) gets a `new_ref` range for every
   * non-default branch only when it has at most this many branches; above it,
   * the repo is seeded only and named in `run.error`. 0 = always seed only.
   */
  newRepoMaxBranches: number;
  /**
   * A range that keeps failing is given up on (`failed`) only once it has
   * used `maxRangeAttempts` AND is at least this old (2026-10-19). Until then
   * it stays `pending` and is retried with backoff, so a short GitHub outage
   * no longer fails ranges for good in 25 minutes.
   */
  rangeGiveUpHours: number;
  /**
   * Hours between scheduled whole-org repo syncs (GithubOrgSyncSchedulerService),
   * so a repo nobody registered is picked up even when no push to it reaches
   * the audit route in ingest mode. 0 = off.
   */
  orgSyncHours: number;
  /**
   * How far back a new branch's own history is read (2026-10-19, branch
   * tracking). A new branch is read from its own commits rather than compared
   * with the default branch, so an unrelated or rewritten history is never
   * missed; this bounds that read so an imported old history is not swept in.
   * Also bounds the fallback read of a moved branch whose Compare fails.
   */
  newBranchLookbackDays: number;
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
  const orgSyncHours = intIn(env, 'GITHUB_ORG_SYNC_HOURS', 24, 0, 24);
  if (!(ALLOWED_ORG_SYNC_HOURS as readonly number[]).includes(orgSyncHours)) {
    throw new Error(
      `Invalid GITHUB_ORG_SYNC_HOURS "${orgSyncHours}". Expected one of ${ALLOWED_ORG_SYNC_HOURS.join(', ')} (0 = off).`,
    );
  }
  return {
    mode,
    intervalMinutes,
    fullSweepMinutes,
    orgSyncHours,
    rangeGiveUpHours: intIn(env, 'GITHUB_AUDIT_RANGE_GIVEUP_HOURS', 24, 1, 168),
    newBranchLookbackDays: intIn(
      env,
      'GITHUB_AUDIT_NEW_BRANCH_LOOKBACK_DAYS',
      30,
      1,
      90,
    ),
    pageSize: intIn(env, 'GITHUB_AUDIT_PAGE_SIZE', 100, 1, 100),
    overlapMinutes: intIn(env, 'GITHUB_AUDIT_OVERLAP_MINUTES', 15, 0, 120),
    compareConcurrency: intIn(env, 'GITHUB_AUDIT_COMPARE_CONCURRENCY', 2, 1, 8),
    maxRangeAttempts: intIn(env, 'GITHUB_AUDIT_MAX_RANGE_ATTEMPTS', 5, 1, 20),
    maxPages: intIn(env, 'GITHUB_AUDIT_MAX_PAGES', 200, 1, 1000),
    lagWarnMinutes: intIn(env, 'GITHUB_AUDIT_LAG_WARN_MINUTES', 30, 5, 1440),
    newRepoMaxBranches: intIn(
      env,
      'GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES',
      50,
      0,
      500,
    ),
  };
}

/**
 * The lag past which the route counts as behind: the configured
 * `lagWarnMinutes`, but never less than two audit intervals — at a 60-minute
 * interval the checkpoint is legitimately up to an hour old before every run,
 * so a 30-minute threshold would warn on every healthy run.
 */
export function effectiveLagWarnMinutes(
  cfg: Pick<GithubAuditConfig, 'lagWarnMinutes' | 'intervalMinutes'>,
): number {
  return Math.max(cfg.lagWarnMinutes, 2 * cfg.intervalMinutes);
}

/** Six-field (seconds-first) cron, as `@nestjs/schedule` accepts. 60 ⇒ top of every hour. */
/**
 * The org-sync cron: 15 past the hour, every `hours` hours (UTC). Off (0)
 * still gets a valid daily expression; the tick gates itself.
 */
export function orgSyncCronExpression(hours: number): string {
  return hours === 0 || hours === 24 ? '0 15 0 * * *' : `0 15 */${hours} * * *`;
}

export function auditCronExpression(intervalMinutes: number): string {
  return intervalMinutes === 60
    ? '0 0 * * * *'
    : `0 */${intervalMinutes} * * * *`;
}

/**
 * Minutes past the hour the full sweep is offset by. Every allowed audit
 * interval fires on a multiple of 5 minutes, so a 2-minute offset means the
 * sweep and the audit tick never fire in the same minute — they share one
 * run-claim and a collision would make the sweep lose it every time.
 */
export const FULL_SWEEP_MINUTE_OFFSET = 2;

/**
 * Cron for the full branch sweep, offset {@link FULL_SWEEP_MINUTE_OFFSET}
 * minutes past the hour: 30 ⇒ :02 and :32; 60 ⇒ :02 hourly; 120/240 ⇒ :02
 * every 2/4 hours. 0 (off) still yields a valid hourly expression because the
 * decorator needs one at module load — `sweepTick` itself returns immediately
 * when off.
 */
export function fullSweepCronExpression(sweepMinutes: number): string {
  const m = FULL_SWEEP_MINUTE_OFFSET;
  if (sweepMinutes === 120 || sweepMinutes === 240) {
    return `0 ${m} */${sweepMinutes / 60} * * *`;
  }
  if (sweepMinutes === 30) {
    return `0 ${m},${m + 30} * * * *`;
  }
  return `0 ${m} * * * *`;
}
