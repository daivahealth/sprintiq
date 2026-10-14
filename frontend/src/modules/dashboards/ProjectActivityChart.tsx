import { cn, dayLabelStride, formatCompact, istDayAxis } from '../../lib/utils';
import { trendTicks } from './monthly-trend';
import type { ProjectActivityRow } from './useInsights';

/**
 * Multi-project changed-LOC timeline (dependency-free SVG): one line per
 * project across the FULL window — empty days included — so projects are
 * comparable at a glance. The plotted projects are the top six by changed LOC;
 * projects are codebases, not people, so volume ordering ranks nobody. LOC is
 * change volume, never productivity. Tooltips carry commits too.
 */
const W = 720;
const H = 200;
const PAD = { top: 12, right: 8, bottom: 26, left: 40 };
const MAX_SERIES = 6;
const COLORS = [
  'stroke-chart-1',
  'stroke-chart-2',
  'stroke-chart-3',
  'stroke-chart-4',
  'stroke-chart-5',
  'stroke-chart-6',
];
const DOT_COLORS = [
  'fill-chart-1',
  'fill-chart-2',
  'fill-chart-3',
  'fill-chart-4',
  'fill-chart-5',
  'fill-chart-6',
];
/** Same series/index mapping as DOT_COLORS, but `bg-*` for the HTML legend swatches (`fill-*` has no effect outside SVG). */
const LEGEND_DOT_COLORS = [
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
  'bg-chart-6',
];

export function ProjectActivityChart({
  rows,
  windowDays,
}: {
  rows: ProjectActivityRow[];
  windowDays: number;
}) {
  // Ordered here as well as by the API, so an older backend that still sorts
  // by commits renders the same chart.
  const active = rows
    .filter((r) => r.commits > 0)
    .sort((a, b) => b.locChanged - a.locChanged || b.commits - a.commits);
  const series = active.slice(0, MAX_SERIES);

  if (series.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-fg-faint">
        No commits in this window.
      </p>
    );
  }

  const days = istDayAxis(windowDays);
  const perProjectDays = series.map((r) => fillWindow(r.dailySeries, days));
  const maxLoc = Math.max(
    0,
    ...perProjectDays.flatMap((d) => d.map((p) => p.locChanged)),
  );

  if (maxLoc === 0) {
    return (
      <p className="py-6 text-center text-sm text-fg-faint">
        Commits in this window recorded no line changes (merge commits, or line
        stats not collected yet).
      </p>
    );
  }

  const yTicks = trendTicks(maxLoc);
  const top = yTicks[yTicks.length - 1] || 1;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const step = days.length > 1 ? plotW / (days.length - 1) : 0;

  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const x = (i: number) => PAD.left + i * step;

  // Thinned only when the labels would actually collide — see dayLabelStride.
  const labelEvery = dayLabelStride(days.length);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Changed lines of code per day by project"
      >
        {yTicks.map((t) => (
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

        {perProjectDays.map((points, seriesIdx) => {
          const line = points
            .map((p, i) => `${x(i).toFixed(1)},${y(p.locChanged).toFixed(1)}`)
            .join(' ');
          return (
            <g key={series[seriesIdx].projectKey}>
              <polyline
                points={line}
                fill="none"
                className={COLORS[seriesIdx % COLORS.length]}
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.9}
              />
              {points.map((p, i) =>
                p.commits > 0 ? (
                  <circle
                    key={p.date}
                    cx={x(i)}
                    cy={y(p.locChanged)}
                    r={2.25}
                    className={DOT_COLORS[seriesIdx % DOT_COLORS.length]}
                  >
                    <title>
                      {series[seriesIdx].projectKey} · {p.date} ·{' '}
                      {p.locChanged.toLocaleString('en-US')} lines changed ·{' '}
                      {p.commits} commit{p.commits === 1 ? '' : 's'}
                    </title>
                  </circle>
                ) : null,
              )}
            </g>
          );
        })}

        {days.map((date, i) =>
          i % labelEvery === 0 || i === days.length - 1 ? (
            <text
              key={`label-${date}`}
              x={x(i)}
              y={H - 8}
              textAnchor="middle"
              className="fill-chart-axis text-[10px]"
            >
              {date.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-fg-faint">
        {series.map((r, i) => (
          <span key={r.projectKey} className="flex items-center gap-1.5">
            <span
              className={cn('h-2 w-2 rounded-none', LEGEND_DOT_COLORS[i % LEGEND_DOT_COLORS.length])}
            />
            {r.projectKey}
          </span>
        ))}
        <span className="ml-auto">hover a point for exact values</span>
      </div>
    </div>
  );
}

/** Fill one project's sparse daily series into the full day axis. */
function fillWindow(
  series: { date: string; commits: number; locChanged: number }[],
  days: string[],
): { date: string; commits: number; locChanged: number }[] {
  const byDate = new Map(series.map((d) => [d.date, d]));
  return days.map((date) => byDate.get(date) ?? { date, commits: 0, locChanged: 0 });
}

