/** The audit route's state as `/dashboards/freshness` reports it. */
export interface AuditRouteFreshness {
  /** Ingest mode with an audit token ref: the route is part of collection. */
  applies: boolean;
  lagMinutes: number | null;
  behind: boolean;
  checkpointAt: string | null;
}

/** "3h 20m", "2d 4h", "45m" — how far behind, in the units a reader uses. */
export function formatLag(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const m = minutes % 60;
    return m ? `${hours}h ${m}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${days}d ${h}h` : `${days}d`;
}

/**
 * The warning a board shows when the audit-log route is behind (2026-10-19),
 * or null when there is nothing to say.
 *
 * Branch-only commits (work on a branch with no pull request) arrive only
 * through that route, so while it lags they are missing from every board, and
 * nothing said so: it once ran 2.8 days behind silently. Silent when the route
 * is not part of collection, when it is on time, and when the board's range
 * ended before the lag began, since those hours are after everything it shows.
 */
export function auditLagWarning(
  audit: AuditRouteFreshness | null | undefined,
  windowTo?: string,
): string | null {
  if (!audit || !audit.applies || !audit.behind || audit.lagMinutes === null) {
    return null;
  }
  if (
    windowTo != null &&
    audit.checkpointAt != null &&
    new Date(windowTo) <= new Date(audit.checkpointAt)
  ) {
    return null;
  }
  return `branch-only commits may be missing — the audit-log route is ${formatLag(audit.lagMinutes)} behind`;
}
