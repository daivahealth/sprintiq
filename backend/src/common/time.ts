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

/**
 * The UTC instant at which an IST calendar date (`YYYY-MM-DD`) begins.
 *
 * The offset is written into the string rather than added afterwards so this
 * cannot drift from `istMidnightUtc` — both mean "00:00 in IST", and IST has no
 * DST, so the literal is exact for every date.
 */
export function istDayStart(key: string): Date {
  return new Date(`${key}T00:00:00.000+05:30`);
}

/**
 * The LAST instant of an IST calendar date — the inclusive upper bound of a
 * range ending on that day.
 *
 * Inclusive because a user picking "to 30 June" means the whole of 30 June;
 * bounding at the next midnight instead would silently swallow the first
 * moment of 1 July.
 */
export function istDayEnd(key: string): Date {
  return new Date(istDayStart(key).getTime() + 86_400_000 - 1);
}

/**
 * Days covered by an IST date range, counting BOTH ends — the same convention
 * as `istWindowFloor`, where a 7-day window covers today plus the six before
 * it. A range's `windowDays` is computed here so the presets and a hand-picked
 * range of the same length report the same number.
 */
export function istDaySpan(fromKey: string, toKey: string): number {
  const days =
    (istDayStart(toKey).getTime() - istDayStart(fromKey).getTime()) /
    86_400_000;
  return Math.round(days) + 1;
}

/** The IST calendar-month key (YYYY-MM) a UTC instant falls in. */
export function istMonthKey(date: Date): string {
  return istDateKey(date).slice(0, 7);
}

/**
 * The UTC instant at which an IST calendar month (`YYYY-MM`) begins.
 *
 * Delegates to `istDayStart` on the first of the month rather than repeating
 * the offset literal, so the month and day boundaries cannot drift apart.
 */
export function istMonthStart(key: string): Date {
  return istDayStart(`${key}-01`);
}

/**
 * The LAST instant of an IST calendar month — the inclusive upper bound of a
 * range covering it, for the same reason `istDayEnd` is inclusive: bounding at
 * the next month's midnight would swallow its first half-hour.
 */
export function istMonthEnd(key: string): Date {
  return new Date(istMonthStart(addIstMonths(key, 1)).getTime() - 1);
}

/**
 * The last `count` IST calendar months, **oldest first**, ending with the month
 * the given moment falls in.
 *
 * Oldest-first because the only consumer plots them left-to-right against time.
 * The day series next to it is newest-first (a list, not a chart) — the two
 * orders are deliberate, and each says so at its own call site.
 */
export function lastIstMonths(count: number, now: Date = new Date()): string[] {
  const current = istMonthKey(now);
  return Array.from({ length: count }, (_, i) =>
    addIstMonths(current, i - (count - 1)),
  );
}

/**
 * Shift a `YYYY-MM` key by whole months, rolling the year over correctly in
 * both directions — the arithmetic a naive `month ± 1` gets wrong at January
 * and December.
 */
function addIstMonths(key: string, delta: number): string {
  const [year, month] = key.split('-').map(Number);
  // Zero-based month arithmetic, so a plain floor/modulo handles the rollover
  // without special-casing either boundary.
  const total = year * 12 + (month - 1) + delta;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * The IST calendar date (YYYY-MM-DD) of the Sunday starting the week a moment
 * falls in — the weekly bucket key for throughput metrics.
 *
 * IST rather than UTC so a Sunday-morning commit in India lands in the week it
 * was actually made, and so weekly buckets line up with the daily ones the
 * activity boards draw.
 */
export function istWeekKey(date: Date): string {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() - shifted.getUTCDay());
  return shifted.toISOString().slice(0, 10);
}
