import { useState } from 'react';
import { istDayAxis } from '../../lib/utils';
import {
  DAY_LABEL_SLOT_PX,
  axisLabelIndices,
  dayAxisLabel,
  dayLongLabel,
  plotBox,
} from './chart-axes';
import {
  ChartTooltip,
  Crosshair,
  HoverDot,
  XAxis,
  YAxis,
} from './ChartFrame';
import { useMeasuredWidth } from './use-measured-width';
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
 * Both axes are titled (2026-11-11): Y names the quantity and its unit, X says
 * the points are calendar days in IST. Hovering shows a crosshair and a
 * tooltip with both quantities, whichever is drawn.
 *
 * Used by the Developer page and the Overview's daily chart. On the Overview a
 * day is still something you open: pass `onSelectDay` and every day gets a
 * full-height hit target, so a click anywhere in its column selects it.
 *
 * Changed LOC is the default view on the Developer page (ADR-0011).
 */
export type DailyMetric = 'loc' | 'commits';

export interface DayPoint {
  date: string; // YYYY-MM-DD
  commits: number;
  locChanged: number;
}

const H = 236;
/** Above this many days a marker per day turns into noise; the line alone reads better. */
const MAX_MARKED_DAYS = 62;

const DAILY_Y_TITLE: Record<DailyMetric, string> = {
  loc: 'Lines changed per day (added + removed)',
  commits: 'Commits per day',
};
const DAILY_X_TITLE = 'Date (IST)';

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
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [hovered, setHovered] = useState<number | null>(null);
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

  const box = plotBox(width, H);
  const ticks = trendTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const step = box.plotW / days.length;

  // Half a step in from each edge, so the first and last points do not sit on
  // the axis line — the same placement as the 12-month trend.
  const x = (i: number) => box.left + i * step + step / 2;
  const y = (v: number) => box.top + box.plotH - (v / top) * box.plotH;

  const shown = axisLabelIndices(days.length, box.plotW, DAY_LABEL_SLOT_PX);
  const xLabels = shown.map((i, n) => ({
    key: days[i].date,
    x: x(i),
    text: dayAxisLabel(days[i].date, n > 0 ? days[shown[n - 1]].date : undefined),
  }));

  // The 12-month trend's colours, so one quantity is one colour on the page.
  // Written out in full rather than composed: Tailwind's scanner cannot see a
  // class built from a prefix and a variable.
  const stroke = metric === 'loc' ? 'stroke-chart-2' : 'stroke-chart-1';
  const fill = metric === 'loc' ? 'fill-chart-2' : 'fill-chart-1';
  const marked = days.length <= MAX_MARKED_DAYS;

  const summary = (d: DayPoint) =>
    `${d.date} · ${d.locChanged.toLocaleString('en-US')} lines changed · ` +
    `${d.commits} commit${d.commits === 1 ? '' : 's'}`;

  const hoverDay = hovered !== null ? days[hovered] : null;

  return (
    <div>
      <div ref={ref} className="relative" onMouseLeave={() => setHovered(null)}>
        <svg
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          className="block w-full"
          role="img"
          aria-label={`${DAILY_Y_TITLE[metric]}, by date (IST)`}
        >
          <YAxis box={box} ticks={ticks} y={y} title={DAILY_Y_TITLE[metric]} />

          {/* The opened day, as a column behind the line. */}
          {days.map((d, i) =>
            d.date === selectedDate ? (
              <rect
                key={`sel-${d.date}`}
                x={box.left + i * step}
                y={box.top}
                width={step}
                height={box.plotH}
                className="fill-brand-muted"
                opacity={0.35}
              />
            ) : null,
          )}

          {hovered !== null && <Crosshair box={box} x={x(hovered)} />}

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
                r={d.date === selectedDate ? 4 : 3}
                className={value(d) > 0 ? fill : 'fill-chart-empty'}
              >
                <title>{summary(d)}</title>
              </circle>
            ) : null,
          )}

          {hoverDay && hovered !== null && (
            <HoverDot cx={x(hovered)} cy={y(value(hoverDay))} tone={fill} />
          )}

          <XAxis box={box} labels={xLabels} title={DAILY_X_TITLE} />

          {/* Full-height, invisible hit targets: hover for the tooltip, and
              the click target when days are selectable. */}
          {days.map((d, i) => (
            <rect
              key={`hit-${d.date}`}
              data-day={d.date}
              x={box.left + i * step}
              y={box.top}
              width={step}
              height={box.plotH}
              fill="transparent"
              onMouseEnter={() => setHovered(i)}
              className={
                onSelectDay
                  ? 'cursor-pointer outline-none focus-visible:fill-brand-muted/40'
                  : undefined
              }
              // Keyboard parity: each day is a focusable button when the chart
              // is interactive, and focusing one shows its tooltip.
              {...(onSelectDay
                ? {
                    role: 'button',
                    tabIndex: 0,
                    'aria-label': summary(d),
                    'aria-pressed': d.date === selectedDate,
                    onFocus: () => setHovered(i),
                    onBlur: () => setHovered(null),
                    onClick: () => onSelectDay(d.date),
                    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectDay(d.date);
                      }
                    },
                  }
                : {})}
            />
          ))}
        </svg>

        {hoverDay && hovered !== null && (
          <ChartTooltip
            box={box}
            x={x(hovered)}
            heading={dayLongLabel(hoverDay.date)}
            rows={[
              {
                key: 'loc',
                label: 'Lines changed',
                value: hoverDay.locChanged.toLocaleString('en-US'),
                swatch: 'bg-chart-2',
                emphasis: metric === 'loc',
              },
              {
                key: 'commits',
                label: 'Commits',
                value: hoverDay.commits.toLocaleString('en-US'),
                swatch: 'bg-chart-1',
                emphasis: metric === 'commits',
              },
            ]}
            footer={onSelectDay ? 'Click to see who committed' : undefined}
          />
        )}
      </div>
      <p className="mt-1 text-right text-xs text-fg-faint">
        {onSelectDay
          ? 'Hover a day for exact values · click to see who committed'
          : 'Hover a day for exact values'}
      </p>
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
