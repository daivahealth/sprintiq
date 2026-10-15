import { dayLabelStride, formatCompact, istDayAxis } from '../../lib/utils';
import { trendTicks } from './monthly-trend';

/**
 * One developer's daily activity (dependency-free SVG): one column per day
 * across the FULL window — empty days included, unlike a sparse list — drawn
 * in ONE metric at a time on an absolute axis labelled in that metric's units.
 *
 * Changed LOC is the default view on the developer page (ADR-0011). The chart
 * used to draw commits as bars with LOC as a "relative scale" overlay; a
 * relative line cannot answer "how much", and the toggle makes it redundant.
 * Native <title> tooltips carry both quantities whichever is drawn.
 */
export type DailyMetric = 'loc' | 'commits';

interface DayPoint {
  date: string; // YYYY-MM-DD
  commits: number;
  locChanged: number;
}

const W = 720;
const H = 180;
const PAD = { top: 12, right: 8, bottom: 26, left: 40 };

export function CommitChart({
  series,
  windowDays,
  endKey,
  metric = 'loc',
}: {
  series: DayPoint[]; // sparse: only days with commits
  windowDays: number;
  /** Last day the chart covers. Defaults to today; a past range passes its end. */
  endKey?: string;
  metric?: DailyMetric;
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
    // nothing", which is false — these are merges or commits whose line stats
    // are not collected yet.
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
  const barW = Math.max(2, step * 0.65);

  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const x = (i: number) => PAD.left + i * step + (step - barW) / 2;

  // Thinned only when the labels would actually collide — see dayLabelStride.
  const labelEvery = dayLabelStride(days.length);
  const label = metric === 'loc' ? 'Changed lines of code per day' : 'Commits per day';

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

        {days.map((d, i) => (
          <rect
            key={d.date}
            x={x(i)}
            y={y(value(d))}
            width={barW}
            height={PAD.top + plotH - y(value(d))}
            rx={1.5}
            className={value(d) > 0 ? 'fill-chart-1' : 'fill-chart-empty'}
          >
            <title>
              {d.date} · {d.locChanged.toLocaleString('en-US')} lines changed ·{' '}
              {d.commits} commit{d.commits === 1 ? '' : 's'}
            </title>
          </rect>
        ))}

        {days.map((d, i) =>
          i % labelEvery === 0 || i === days.length - 1 ? (
            <text
              key={`label-${d.date}`}
              x={x(i) + barW / 2}
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
          <span className="h-2 w-2 rounded-sm bg-chart-1" />
          {metric === 'loc' ? 'changed lines (added + removed)' : 'commits'}
        </span>
        <span className="ml-auto">hover a bar for exact values</span>
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
