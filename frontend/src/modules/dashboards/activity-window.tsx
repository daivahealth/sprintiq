import { Button, SegmentedControl } from '../../components/ui';
import { istDaySpan, istDayStart, istWindowFloor } from '../../lib/utils';
import type { ActivityRange } from './activity-range';
import type { ActivityWindow } from './useInsights';

/**
 * The activity boards' shared range vocabulary.
 *
 * One copy, used by both Engineering Activity and Project Activity. They select
 * from the same five ranges against the same backend mapping, and a second
 * copy is how the two drift apart — which matters more here than anywhere,
 * since this file's whole subject is ranges that mean exactly what they say.
 *
 * Ranges are named for what they measure. "Today" survives as a word because it
 * is genuinely calendar-aligned — the server floors to IST midnight, so it means
 * today, not the last 24 hours. The others don't get that licence: 30 calendar
 * days ending on 25 Aug begins on 27 Jul, which is not "this month", and a
 * section whose whole purpose is trustworthy numbers shouldn't round its own
 * range in the label.
 */
export const WINDOWS: { key: ActivityWindow; label: string }[] = [
  { key: 'day', label: 'Today' },
  { key: 'week', label: '7 days' },
  { key: 'month', label: '30 days' },
  { key: 'quarter', label: '90 days' },
  { key: 'year', label: '12 months' },
];

/** Mirrors the backend ACTIVITY_WINDOWS mapping (insights.controller). */
export const WINDOW_DAYS: Record<ActivityWindow, number> = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 90,
  year: 365,
};

/** The next range up, for the empty state to offer. Undefined at the widest. */
export function widerWindow(
  window: ActivityWindow,
): ActivityWindow | undefined {
  const i = WINDOWS.findIndex((w) => w.key === window);
  return WINDOWS[i + 1]?.key;
}

export function windowLabel(window: ActivityWindow): string {
  return WINDOWS.find((w) => w.key === window)?.label ?? String(window);
}

/**
 * First instant of the selected window — the shared `istWindowFloor`, which
 * mirrors the backend's exactly.
 *
 * The board this replaced once computed its own `now - days * 86400000`. That
 * is the rolling convention DASHBOARDS.md §4.1.1 records as retired, and the
 * reason it matters is `FreshnessNote`: it judges the SECTION's window rather
 * than the dataset, so a start up to a day earlier than the one actually
 * queried had it vouching for — or warning about — time nothing ever showed.
 */
export function windowStart(window: ActivityWindow): Date {
  return istWindowFloor(WINDOW_DAYS[window]);
}

export function windowFrom(window: ActivityWindow): string {
  return windowStart(window).toISOString();
}

/** "27 Jul" — the interval ends today, so the year is noise until it isn't. */
export function shortDate(d: Date): string {
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** IST day key ("2026-08-14") → "Thu, 14 Aug". */
export function formatDayKey(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

export function WindowToggle({
  value,
  onChange,
}: {
  value: ActivityWindow;
  onChange: (w: ActivityWindow) => void;
}) {
  return (
    <SegmentedControl
      label="Window"
      value={value}
      onChange={onChange}
      options={WINDOWS.map((w) => ({ value: w.key, label: w.label }))}
    />
  );
}

/**
 * What an empty board says instead of nothing.
 *
 * A blank result has two causes that look identical on screen — nothing
 * happened, or nothing happened *in the range you picked* — and the board this
 * came from rendered both as one dim sentence. That is not a cosmetic gap: a
 * repository dormant since July shows every one of its developers at zero on
 * every window offered, and a reader reasonably concludes those people are
 * inactive. Naming the interval and offering the next one up turns an absence
 * into a reading with a range attached.
 *
 * Styled as an inset caveat rather than centred filler because the boards
 * already have that vocabulary for truncation notes, and it sits at
 * `fg-subtle` rather than `fg-faint` — this is provenance, which the design
 * system keeps legible on purpose, not decoration.
 *
 * A custom range names its own interval and offers no wider one: there is no
 * defined "next range up" from an arbitrary interval, and inventing one would
 * be guessing at what the reader meant.
 *
 * NOTE: `ActivityRange` is imported as a TYPE only, and this file must never
 * import a value from `activity-range` — that module imports `WINDOW_DAYS` and
 * `windowLabel` from here, so a value import back would close a runtime cycle
 * between the two. A type import is erased at compile time and closes nothing,
 * which is why the day count below is computed from `istDaySpan` directly
 * rather than by calling `rangeDays`.
 */
export function EmptyWindowNote({
  range,
  measuredDays,
  onChange,
  noun = 'commits',
}: {
  range: ActivityRange;
  /** Days the server measured; falls back to the selection if it didn't say. */
  measuredDays?: number;
  onChange: (r: ActivityRange) => void;
  noun?: string;
}) {
  const custom = range.kind === 'custom';
  const days =
    measuredDays ??
    (range.kind === 'custom'
      ? istDaySpan(range.from, range.to)
      : WINDOW_DAYS[range.window]);
  const end = range.kind === 'custom' ? istDayStart(range.to) : new Date();
  const start =
    range.kind === 'custom'
      ? istDayStart(range.from)
      : new Date(
          windowStart(range.window).getTime() +
            (WINDOW_DAYS[range.window] - days) * 86_400_000,
        );
  const wider = range.kind === 'custom' ? undefined : widerWindow(range.window);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-subtle p-2.5">
      <p className="text-xs text-fg-subtle">
        No {noun}{' '}
        {days === 1 && !custom ? (
          <>
            today (
            <span className="font-mono tabular-nums">{shortDate(end)}</span>)
          </>
        ) : (
          <>
            between{' '}
            <span className="font-mono tabular-nums">{shortDate(start)}</span>
            {' and '}
            <span className="font-mono tabular-nums">{shortDate(end)}</span>
          </>
        )}
        .{' '}
        {custom
          ? 'Work outside this range is not counted here.'
          : wider
            ? 'Work older than this range is not counted here.'
            : 'This is the widest range available.'}
      </p>
      {wider && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange({ kind: 'preset', window: wider })}
        >
          Try {windowLabel(wider)}
        </Button>
      )}
    </div>
  );
}
