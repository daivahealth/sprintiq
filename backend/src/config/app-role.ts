/**
 * Process role. The same image runs as one of these via APP_ROLE.
 * See docs/deployment/README.md §1.
 */
export enum AppRole {
  /** Dashboard BFF + admin + auth — end-user traffic (/api/*). */
  API = 'api',
  /** Public webhook receivers + ingestion pipeline (BC-1) (/webhooks/*). */
  COLLECTOR = 'collector',
  /** Scheduled pollers, rollups, rule sweeps, agent jobs, notifications. */
  WORKER = 'worker',
}

export function resolveAppRole(value?: string): AppRole {
  const role = (value ?? AppRole.API).toLowerCase();
  if (
    role === AppRole.API ||
    role === AppRole.COLLECTOR ||
    role === AppRole.WORKER
  ) {
    return role as AppRole;
  }
  throw new Error(
    `Invalid APP_ROLE "${value}". Expected one of: api | collector | worker.`,
  );
}

/** Roles that expose public HTTP listeners (others still expose /health only). */
export function roleServesHttp(role: AppRole): boolean {
  return role === AppRole.API || role === AppRole.COLLECTOR;
}

/** Roles that run scheduled jobs (pollers, rollups, sweeps, digests). */
export function roleRunsScheduler(role: AppRole): boolean {
  return role === AppRole.WORKER;
}
