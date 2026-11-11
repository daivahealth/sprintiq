import { useState, type MouseEvent } from 'react';
import { cn, istDayAxis } from '../../lib/utils';
import {
  DAY_LABEL_SLOT_PX,
  axisLabelIndices,
  dayAxisLabel,
  dayLongLabel,
  plotBox,
  slotAt,
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
import type { ProjectActivityRow } from './useInsights';

/**
 * Multi-project changed-LOC timeline (dependency-free SVG): one line per
 * project across the FULL window — empty days included — so projects are
 * comparable at a glance. The plotted projects are the top six by changed LOC;
 * projects are codebases, not people, so volume ordering ranks nobody. LOC is
 * change volume, never productivity.
 *
 * Both axes are titled (2026-11-11). Hovering a day shows every plotted
 * project's lines and commits for it, in legend order.
 */
const H = 256;
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

const PROJECT_Y_TITLE = 'Lines changed per day (added + removed)';
const PROJECT_X_TITLE = 'Date (IST)';

export function ProjectActivityChart({
  rows,
  windowDays,
}: {
  rows: ProjectActivityRow[];
  windowDays: number;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [hovered, setHovered] = useState<number | null>(null);

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
        Commits in this window recorded no line changes (line stats not collected
        yet, or commits that change no lines).
      </p>
    );
  }

  const box = plotBox(width, H);
  const yTicks = trendTicks(maxLoc);
  const top = yTicks[yTicks.length - 1] || 1;
  const step = days.length > 1 ? box.plotW / (days.length - 1) : 0;

  const y = (v: number) => box.top + box.plotH - (v / top) * box.plotH;
  const x = (i: number) => box.left + i * step;

  const shown = axisLabelIndices(days.length, box.plotW, DAY_LABEL_SLOT_PX);
  const xLabels = shown.map((i, n) => ({
    key: days[i],
    x: x(i),
    text: dayAxisLabel(days[i], n > 0 ? days[shown[n - 1]] : undefined),
  }));

  const onMove = (e: MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect) return;
    setHovered(slotAt(e.clientX - rect.left, box.left, step, days.length, false));
  };

  return (
    <div>
      <div ref={ref} className="relative" onMouseLeave={() => setHovered(null)}>
        <svg
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          className="block w-full"
          role="img"
          aria-label={`${PROJECT_Y_TITLE} by project, by date (IST)`}
        >
          <YAxis box={box} ticks={yTicks} y={y} title={PROJECT_Y_TITLE} />

          {hovered !== null && <Crosshair box={box} x={x(hovered)} />}

          {perProjectDays.map((points, seriesIdx) => {
            const line = points
              .map((p, i) => `${x(i).toFixed(1)},${y(p.locChanged).toFixed(1)}`)
              .join(' ');
            const projectKey = series[seriesIdx].projectKey;
            return (
              <g key={projectKey}>
                <polyline
                  points={line}
                  fill="none"
                  className={COLORS[seriesIdx % COLORS.length]}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {points.map((p, i) =>
                  p.commits > 0 ? (
                    <circle
                      key={p.date}
                      cx={x(i)}
                      cy={y(p.locChanged)}
                      r={3}
                      className={DOT_COLORS[seriesIdx % DOT_COLORS.length]}
                      stroke="rgb(var(--surface))"
                      strokeWidth={1}
                    >
                      {/* ONE string: `<title>` takes a single text child, and
                          sibling JSX children render as an array that warns
                          and does not hydrate reliably. */}
                      <title>
                        {`${projectKey} · ${p.date} · ` +
                          `${p.locChanged.toLocaleString('en-US')} lines changed · ` +
                          `${p.commits} commit${p.commits === 1 ? '' : 's'}`}
                      </title>
                    </circle>
                  ) : null,
                )}
              </g>
            );
          })}

          {hovered !== null &&
            perProjectDays.map((points, seriesIdx) => (
              <HoverDot
                key={`hover-${series[seriesIdx].projectKey}`}
                cx={x(hovered)}
                cy={y(points[hovered].locChanged)}
                tone={DOT_COLORS[seriesIdx % DOT_COLORS.length]}
              />
            ))}

          <XAxis box={box} labels={xLabels} title={PROJECT_X_TITLE} />

          <rect
            // Half a step either side so the end days are as easy to hover as
            // the rest, clamped to the drawing.
            x={Math.max(0, box.left - step / 2)}
            y={box.top}
            width={Math.min(box.width, box.right + step / 2) - Math.max(0, box.left - step / 2)}
            height={box.plotH}
            fill="transparent"
            onMouseMove={onMove}
            data-hover-surface
          />
        </svg>

        {hovered !== null && (
          <ChartTooltip
            box={box}
            x={x(hovered)}
            heading={dayLongLabel(days[hovered])}
            rows={perProjectDays.map((points, seriesIdx) => {
              const p = points[hovered];
              return {
                key: series[seriesIdx].projectKey,
                label: series[seriesIdx].projectKey,
                value:
                  `${p.locChanged.toLocaleString('en-US')} lines · ` +
                  `${p.commits} commit${p.commits === 1 ? '' : 's'}`,
                swatch: LEGEND_DOT_COLORS[seriesIdx % LEGEND_DOT_COLORS.length],
              };
            })}
          />
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
        <span className="text-fg-faint">
          {active.length > MAX_SERIES
            ? `Projects (top ${MAX_SERIES} of ${active.length} by lines changed):`
            : 'Projects:'}
        </span>
        {series.map((r, i) => (
          <span key={r.projectKey} className="flex items-center gap-1.5">
            <span
              className={cn('h-2 w-2 rounded-sm', LEGEND_DOT_COLORS[i % LEGEND_DOT_COLORS.length])}
            />
            {r.projectKey}
          </span>
        ))}
        <span className="ml-auto text-fg-faint">Hover a day for exact values</span>
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
