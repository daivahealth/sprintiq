import {
  istDayKeyOffset,
  istDaySpan,
  istDayStart,
  istTodayKey,
  istWindowFloor,
} from '../../lib/utils';
import { WINDOW_DAYS, windowLabel } from './activity-window';
import type { ActivityWindow } from './useInsights';

/**
 * What the Engineering Activity section is reading: one of the five shared
 * presets, or an arbitrary interval.
 *
 * The presets deliberately keep their own type. `ActivityWindow` is the
 * vocabulary shared with Project Activity, which does NOT offer a custom range;
 * widening that union would have made every one of its consumers handle a case
 * it can never receive.
 *
 * A custom range is two IST calendar-date keys, INCLUSIVE at both ends — the
 * same convention as `istWindowFloor`, which is what makes a hand-picked seven
 * days and the "7 days" preset return identical numbers.
 */
export type ActivityRange =
  | { kind: 'preset'; window: ActivityWindow }
  | { kind: 'custom'; from: string; to: string };

export const DEFAULT_RANGE: ActivityRange = { kind: 'preset', window: 'week' };

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The query params every Engineering Activity endpoint takes. */
export function rangeParams(range: ActivityRange): URLSearchParams {
  const params = new URLSearchParams();
  if (range.kind === 'preset') {
    params.set('window', range.window);
    return params;
  }
  params.set('window', 'custom');
  params.set('from', range.from);
  params.set('to', range.to);
  return params;
}

function isDateKey(value: string): boolean {
  return DATE_KEY.test(value) && !Number.isNaN(istDayStart(value).getTime());
}

/** Both dates readable, in order, and not reaching into the future. */
export function isValidCustom(from: string, to: string): boolean {
  return isDateKey(from) && isDateKey(to) && from <= to && to <= istTodayKey();
}

/**
 * The range a URL is asking for.
 *
 * Anything unreadable falls back to the default rather than throwing: a
 * hand-edited or truncated link must not blank the section, and the control
 * shows what was actually applied.
 */
export function parseRange(params: URLSearchParams): ActivityRange {
  const window = params.get('window');
  if (window === 'custom') {
    const from = params.get('from') ?? '';
    const to = params.get('to') ?? '';
    return isValidCustom(from, to)
      ? { kind: 'custom', from, to }
      : DEFAULT_RANGE;
  }
  return window && window in WINDOW_DAYS
    ? { kind: 'preset', window: window as ActivityWindow }
    : DEFAULT_RANGE;
}

/** Days the range covers, inclusive — matches the API's `windowDays`. */
export function rangeDays(range: ActivityRange): number {
  return range.kind === 'preset'
    ? WINDOW_DAYS[range.window]
    : istDaySpan(range.from, range.to);
}

/** Last IST day the range covers — the day a chart axis must end on. */
export function rangeEndKey(range: ActivityRange): string {
  return range.kind === 'preset' ? istTodayKey() : range.to;
}

/** First instant of the range, for `FreshnessNote`. */
export function rangeFrom(range: ActivityRange): string {
  return (
    range.kind === 'preset'
      ? istWindowFloor(WINDOW_DAYS[range.window])
      : istDayStart(range.from)
  ).toISOString();
}

/**
 * Last instant of the range, or undefined for a preset — which ends now, and
 * so has no bound worth stating.
 */
export function rangeTo(range: ActivityRange): string | undefined {
  if (range.kind === 'preset') {
    return undefined;
  }
  return new Date(
    istDayStart(range.to).getTime() + 86_400_000 - 1,
  ).toISOString();
}

/**
 * True when the range stops before today. The trigger for every "this lens is
 * current, not as-of" caveat: those figures have no collected history, so on a
 * past range they describe a different moment than the rest of the page.
 */
export function rangeEndsInPast(range: ActivityRange): boolean {
  return range.kind === 'custom' && range.to < istTodayKey();
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * "1 Apr 2026" from a date key.
 *
 * Built from a fixed table rather than `toLocaleDateString` for two reasons: a
 * custom range can cross a year boundary, so the year is never noise here the
 * way it is in `shortDate`; and a locale-dependent label cannot be pinned in a
 * test, which is most of what this module's tests are for.
 */
export function formatDateKey(key: string): string {
  const [year, month, day] = key.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

/** What to call this range on screen. */
export function rangeLabel(range: ActivityRange): string {
  return range.kind === 'preset'
    ? windowLabel(range.window)
    : `${formatDateKey(range.from)} – ${formatDateKey(range.to)}`;
}

/**
 * The date pair equivalent to a preset — what the custom fields are seeded
 * with, so choosing Custom never blanks the board: you start on the range you
 * were already reading.
 */
export function presetDateKeys(window: ActivityWindow): {
  from: string;
  to: string;
} {
  const to = istTodayKey();
  return { from: istDayKeyOffset(to, -(WINDOW_DAYS[window] - 1)), to };
}
