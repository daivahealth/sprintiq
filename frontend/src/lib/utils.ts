import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** className combiner with Tailwind conflict resolution (last write wins). */
export function cn(...classes: ClassValue[]): string {
  return twMerge(clsx(classes));
}

/** Human-friendly "time ago" for freshness indicators. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** IST has no DST, so a static +5:30 shift always gives the correct calendar date. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The last `windowDays` IST calendar-date keys (YYYY-MM-DD), ending today,
 * oldest first — for building a contiguous day axis. Must stay in sync with
 * the backend's `dailySeries` bucketing (`insights.service.ts`'s `istDateKey`)
 * or the axis and the data it's zero-filling against will disagree on what
 * "today" means.
 */
/**
 * The UTC instant of IST midnight `windowDays - 1` days ago — the start of a
 * calendar-aligned window ending today.
 *
 * Mirrors the backend's `istWindowFloor` exactly. This is the app's ONE window
 * definition: before it, the Scope Bar sent a rolling `now - days*86400000`
 * while the activity boards used IST calendar days, so "last 7 days" denoted
 * two different ranges depending on which board you were reading, differing by
 * up to a full day at each edge.
 */
export function istWindowFloor(windowDays: number): Date {
  const todayIst = new Date(Date.now() + IST_OFFSET_MS);
  todayIst.setUTCHours(0, 0, 0, 0);
  const istMidnightUtc = new Date(todayIst.getTime() - IST_OFFSET_MS);
  return new Date(istMidnightUtc.getTime() - (windowDays - 1) * 86_400_000);
}

/** Today's IST calendar-date key (YYYY-MM-DD). */
export function istTodayKey(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The UTC instant at which an IST calendar date begins. Mirrors the backend's
 * `istDayStart` — the offset is in the string so it cannot drift from
 * `istWindowFloor`, and IST has no DST, so the literal is exact for every date.
 */
export function istDayStart(key: string): Date {
  return new Date(`${key}T00:00:00.000+05:30`);
}

/**
 * Days covered by an IST date range, counting BOTH ends — the same convention
 * as `istWindowFloor`, where 7 days is today plus the six before it. Mirrors
 * the backend's `istDaySpan`, which computes the `windowDays` the API echoes.
 */
export function istDaySpan(fromKey: string, toKey: string): number {
  const days =
    (istDayStart(toKey).getTime() - istDayStart(fromKey).getTime()) /
    86_400_000;
  return Math.round(days) + 1;
}

/**
 * A date key moved by whole days. Key arithmetic is anchored on UTC midnight
 * rather than IST, because shifting both ends by the same offset cannot change
 * a difference in days — and the UTC anchor keeps the arithmetic exact.
 */
export function istDayKeyOffset(key: string, deltaDays: number): string {
  const anchor = new Date(`${key}T00:00:00.000Z`).getTime();
  return new Date(anchor + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * `windowDays` contiguous IST date keys ending on `endKey` (today by default),
 * oldest first — the axis a chart zero-fills a sparse series against. Must stay
 * in sync with the backend's `istDateKey` bucketing, or the axis and the data
 * disagree about what a day is.
 *
 * The end is a parameter because a custom range can end in the past. An axis
 * hardcoded to today drew a closed April–June range as an unbroken row of
 * zeros, every real commit having fallen off the left of a window ending now.
 */
export function istDayAxis(
  windowDays: number,
  endKey: string = istTodayKey(),
): string[] {
  const out: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    out.push(istDayKeyOffset(endKey, -i));
  }
  return out;
}

/**
 * How many day-labels to skip on a chart's x-axis so they don't collide.
 *
 * Thinning only kicks in once labels would actually overlap. The previous rule
 * was an unconditional `ceil(days / 6)`, tuned for the 30-day view and never
 * reconsidered for shorter ones — at 7 days it returned 2 and dropped three of
 * the week's seven dates for no reason, since seven `MM-DD` labels fit across
 * the axis with room to spare.
 */
export function dayLabelStride(dayCount: number): number {
  const MAX_LABELS_THAT_FIT = 10;
  if (dayCount <= MAX_LABELS_THAT_FIT) {
    return 1;
  }
  return Math.ceil(dayCount / 6);
}

/** Hours → compact "Xh"/"Yd Zh" label. */
export function formatHours(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours % 24);
  return h ? `${d}d ${h}h` : `${d}d`;
}
