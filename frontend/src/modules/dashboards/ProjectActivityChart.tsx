import type { ProjectActivityRow } from './useInsights';

/**
 * Multi-project commit timeline (dependency-free SVG): one line per project
 * across the FULL window — zero-commit days included — so projects are
 * comparable at a glance. Mirrors CommitChart's style/conventions but plots
 * several series instead of one, since this compares projects rather than
 * showing one developer's day-by-day detail.
 */
const W = 720;
const H = 200;
const PAD = { top: 12, right: 8, bottom: 26, left: 30 };
const MAX_SERIES = 6;
const COLORS = [
  'stroke-brand',
  'stroke-emerald-500',
  'stroke-amber-500',
  'stroke-rose-500',
  'stroke-indigo-500',
  'stroke-cyan-500',
];
const DOT_COLORS = [
  'fill-brand',
  'fill-emerald-500',
  'fill-amber-500',
  'fill-rose-500',
  'fill-indigo-500',
  'fill-cyan-500',
];

export function ProjectActivityChart({
  rows,
  windowDays,
}: {
  rows: ProjectActivityRow[];
  windowDays: number;
}) {
  const series = rows.slice(0, MAX_SERIES).filter((r) => r.commits > 0);

  if (series.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-slate-400">
        No commits in this window.
      </p>
    );
  }

  const days = buildDayAxis(windowDays);
  const perProjectDays = series.map((r) => fillWindow(r.dailySeries, days));
  const maxCommits = Math.max(
    1,
    ...perProjectDays.flatMap((d) => d.map((p) => p.commits)),
  );

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const step = days.length > 1 ? plotW / (days.length - 1) : 0;

  const y = (v: number) => PAD.top + plotH - (v / maxCommits) * plotH;
  const x = (i: number) => PAD.left + i * step;

  const labelEvery = Math.max(1, Math.ceil(days.length / 6));
  const yTicks = commitTicks(maxCommits);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Commits per day by project"
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              className="stroke-slate-100"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(t) + 3}
              textAnchor="end"
              className="fill-slate-400 text-[10px]"
            >
              {t}
            </text>
          </g>
        ))}

        {perProjectDays.map((points, seriesIdx) => {
          const line = points
            .map((p, i) => `${x(i).toFixed(1)},${y(p.commits).toFixed(1)}`)
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
                    cy={y(p.commits)}
                    r={2.25}
                    className={DOT_COLORS[seriesIdx % DOT_COLORS.length]}
                  >
                    <title>
                      {series[seriesIdx].projectKey} · {p.date} · {p.commits}{' '}
                      commit{p.commits === 1 ? '' : 's'} · {p.locChanged} LOC
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
              className="fill-slate-400 text-[10px]"
            >
              {date.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-400">
        {series.map((r, i) => (
          <span key={r.projectKey} className="flex items-center gap-1.5">
            <span
              className={`h-2 w-2 rounded-full ${DOT_COLORS[i % DOT_COLORS.length]}`}
            />
            {r.projectKey}
          </span>
        ))}
        <span className="ml-auto">hover a point for exact values</span>
      </div>
    </div>
  );
}

/** Contiguous [today-windowDays+1 … today] date-string axis, UTC-anchored. */
function buildDayAxis(windowDays: number): string[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const out: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    out.push(new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** Fill one project's sparse daily series into the full day axis. */
function fillWindow(
  series: { date: string; commits: number; locChanged: number }[],
  days: string[],
): { date: string; commits: number; locChanged: number }[] {
  const byDate = new Map(series.map((d) => [d.date, d]));
  return days.map((date) => byDate.get(date) ?? { date, commits: 0, locChanged: 0 });
}

/** 3–4 clean integer ticks for the commits axis. */
function commitTicks(max: number): number[] {
  if (max <= 3) {
    return Array.from({ length: max + 1 }, (_, i) => i);
  }
  const stepSize = Math.ceil(max / 3);
  const ticks: number[] = [];
  for (let t = 0; t <= max; t += stepSize) {
    ticks.push(t);
  }
  return ticks;
}
