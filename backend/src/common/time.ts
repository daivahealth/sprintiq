/**
 * India Standard Time helpers for calendar-day windowing (Developer/Project
 * Activity). IST has no DST, so a static +5:30 shift always gives the
 * correct calendar date/midnight — no timezone database needed.
 *
 * This is deliberately hardcoded rather than per-user-configurable: this
 * deployment's tenant and users are India-based, and a generic timezone
 * system (browser-detected, per-user preference, etc.) would be scope far
 * beyond the bug this fixes.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The IST calendar-date key (YYYY-MM-DD) a UTC instant falls on. */
export function istDateKey(date: Date): string {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The UTC instant of IST midnight for the given moment (defaults to now). */
export function istMidnightUtc(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}

/**
 * Calendar-aligned floor for a `days`-long window ending today (IST) — e.g.
 * `istWindowFloor(1)` is "since IST midnight today", not a rolling 24h
 * lookback from now, so "Today" always means the current IST calendar day.
 */
export function istWindowFloor(days: number, now: Date = new Date()): Date {
  return new Date(istMidnightUtc(now).getTime() - (days - 1) * 86_400_000);
}
