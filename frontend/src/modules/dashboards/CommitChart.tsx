import { dayLabelStride, formatCompact, istDayAxis } from '../../lib/utils';
import { trendTicks } from './monthly-trend';

/**
 * Daily activity as a line (dependency-free SVG): one point per day across the
 * FULL window — empty days included, unlike a sparse list — drawn in ONE metric
 * at a time on an absolute axis labelled in that metric's units.
 *
 * A line rather than bars (2026-10-19) for the same reason the 12-month trend
 * is one: the question is the shape of the window — where volume climbed and
 * where it fell away — and separated bars make the reader do that differencing
 * by eye. A day with nothing is a point on the zero line, not a gap: inside the
 * window it is a measurement, not missing data.
 *
 * Used by the Developer page and the Overview's daily chart. On the Overview a
 * day is still something you open: pass `onSelectDay` and every day gets a
 * full-height hit target, so a click anywhere in its column selects it — a
 * 4px marker would be a far worse target than the bar it replaced.
 *
 * Changed LOC is the default view on the Developer page (ADR-0011). Native
 * <title> tooltips carry both quantities whichever is drawn.
 */
export type DailyMetric = 'loc' | 'commits';

export interface DayPoint {
  date: string; // YYYY-MM-DD
  commits: number;
  locChanged: number;
}

const W = 720;
const H = 180;
const PAD = { top: 12, right: 12, bottom: 26, left: 40 };
/** Above this many days a marker per day turns into noise; the line alone reads better. */
const MAX_MARKED_DAYS = 62;

export function CommitChart({
  series,
  windowDays,
  endKey,
  metric = 'loc',
  selectedDate,
  onSelectDay,
}: {
  series: DayPoint[]; // sparse: only days with commits
  windowDays: number;
  /** Last day the chart covers. Defaults to today; a past range passes its end. */
  endKey?: string;
  metric?: DailyMetric;
  /** The day currently opened, highlighted on the chart. */
  selectedDate?: string | null;
  /** Makes each day clickable. Called with the day's `YYYY-MM-DD`. */
  onSelectDay?: (date: string) => void;
}) {
  const days = buildFullWindow(series, windowDays, endKey);
  const totalCommits = days.reduce((s, d) => s + d.commits, 0);

  if (totalCommits === 0) {
    return (
      <p className="py-6 text-center text-sm text-fg-faint">
        No commits in this window.
      </p>
    );
  }

  const value = (d: DayPoint) =>
    metric === 'loc' ? d.locChanged : d.commits;
  const max = Math.max(...days.map(value));

  if (metric === 'loc' && max === 0) {
    // Not an empty chart: an empty LOC axis over real commits reads as "did
    // nothing", which is false — these are commits whose line stats are not
    // collected yet, or that change no lines.
    return (
      <p className="py-6 text-center text-sm text-fg-faint">
        The {totalCommits} commit{totalCommits === 1 ? '' : 's'} in this window
        recorded no line changes (line stats not collected yet, or commits
        that change no lines). Switch to Commits to see them.
      </p>
    );
  }

  const ticks = trendTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const step = plotW / days.length;

  // Half a step in from each edge, so the first and last points do not sit on
  // the axis line — the same placement as the 12-month trend.
  const x = (i: number) => PAD.left + i * step + step / 2;
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;

  // Thinned only when the labels would actually collide — see dayLabelStride.
  const labelEvery = dayLabelStride(days.length);
  const label =
    metric === 'loc' ? 'Changed lines of code per day' : 'Commits per day';
  // The 12-month trend's colours, so one quantity is one colour on the page.
  // Written out in full rather than composed: Tailwind's scanner cannot see a
  // class built from a prefix and a variable.
  const stroke = metric === 'loc' ? 'stroke-chart-2' : 'stroke-chart-1';
  const fill = metric === 'loc' ? 'fill-chart-2' : 'fill-chart-1';
  const marked = days.length <= MAX_MARKED_DAYS;

  const tooltip = (d: DayPoint) =>
    `${d.date} · ${d.locChanged.toLocaleString('en-US')} lines changed · ` +
    `${d.commits} commit${d.commits === 1 ? '' : 's'}`;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              className="stroke-chart-grid"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(t) + 3}
              textAnchor="end"
              className="fill-chart-axis text-[10px]"
            >
              {formatCompact(t)}
            </text>
          </g>
        ))}

        {/* The opened day, as a column behind the line. */}
        {days.map((d, i) =>
          d.date === selectedDate ? (
            <rect
              key={`sel-${d.date}`}
              x={PAD.left + i * step}
              y={PAD.top}
              width={step}
              height={plotH}
              className="fill-brand-muted"
              opacity={0.35}
            />
          ) : null,
        )}

        <polyline
          points={days
            .map((d, i) => `${x(i).toFixed(1)},${y(value(d)).toFixed(1)}`)
            .join(' ')}
          fill="none"
          className={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {days.map((d, i) =>
          marked || d.date === selectedDate ? (
            <circle
              key={`pt-${d.date}`}
              cx={x(i)}
              cy={y(value(d))}
              r={d.date === selectedDate ? 4 : 2.5}
              className={value(d) > 0 ? fill : 'fill-chart-empty'}
            >
              <title>{tooltip(d)}</title>
            </circle>
          ) : null,
        )}

        {/* Full-height, invisible hit targets: the tooltip for every day, and
            the click target when days are selectable. */}
        {days.map((d, i) => (
          <rect
            key={`hit-${d.date}`}
            data-day={d.date}
            x={PAD.left + i * step}
            y={PAD.top}
            width={step}
            height={plotH}
            fill="transparent"
            className={
              onSelectDay
                ? 'cursor-pointer outline-none focus-visible:fill-brand-muted/40'
                : undefined
            }
            // Keyboard parity with the buttons this replaced: each day is a
            // focusable button when the chart is interactive.
            {...(onSelectDay
              ? {
                  role: 'button',
                  tabIndex: 0,
                  'aria-label': tooltip(d),
                  'aria-pressed': d.date === selectedDate,
                  onClick: () => onSelectDay(d.date),
                  onKeyDown: (e: { key: string; preventDefault: () => void }) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectDay(d.date);
                    }
                  },
                }
              : {})}
          >
            <title>{tooltip(d)}</title>
          </rect>
        ))}

        {days.map((d, i) =>
          i % labelEvery === 0 || i === days.length - 1 ? (
            <text
              key={`label-${d.date}`}
              x={x(i)}
              y={H - 8}
              textAnchor="middle"
              className="fill-chart-axis text-[10px]"
            >
              {d.date.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      <div className="mt-1 flex items-center gap-4 text-xs text-fg-faint">
        <span className="flex items-center gap-1.5">
          <span
            className={
              metric === 'loc'
                ? 'h-0.5 w-3 rounded-full bg-chart-2'
                : 'h-0.5 w-3 rounded-full bg-chart-1'
            }
          />
          {metric === 'loc' ? 'changed lines (added + removed)' : 'commits'}
        </span>
        <span className="ml-auto">
          {onSelectDay
            ? 'hover a day for exact values · click to see who committed'
            : 'hover a day for exact values'}
        </span>
      </div>
    </div>
  );
}

/** Fill the sparse series into a contiguous [end-windowDays+1 … end] range. */
function buildFullWindow(
  series: DayPoint[],
  windowDays: number,
  endKey?: string,
): DayPoint[] {
  const byDate = new Map(series.map((d) => [d.date, d]));
  return istDayAxis(windowDays, endKey).map(
    (date) => byDate.get(date) ?? { date, commits: 0, locChanged: 0 },
  );
}
