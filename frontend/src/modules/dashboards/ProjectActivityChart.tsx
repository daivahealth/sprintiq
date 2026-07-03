import type { ProjectActivityRow } from './useInsights';

/**
 * Daily activity timeline across projects (dependency-free SVG): stacked
 * columns per day over the FULL window — one color per project — so you can
 * see WHEN activity happened and which projects drove it. Hover a segment for
 * exact values. Complements the ranked table below it.
 */
const W = 720;
const H = 200;
const PAD = { top: 12, right: 8, bottom: 26, left: 30 };

/** Explicit hex palette (SVG fills; cycles when projects exceed the list). */
const PALETTE = [
  '#4f46e5', // indigo (brand)
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#0ea5e9', // sky
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#64748b', // slate — also used for '(unlinked repos)'
];

export function ProjectActivityChart({
  rows,
  windowDays,
}: {
  rows: ProjectActivityRow[];
  windowDays: number;
}) {
  // Stable stack order = ranked row order; unlinked bucket keeps slate.
  const projects = rows.map((r) => r.projectKey);
  const colorOf = (project: string, i: number) =>
    project === '(unlinked repos)' ? '#94a3b8' : PALETTE[i % PALETTE.length];

  const days = buildWindow(windowDays);
  const perDay = days.map((date) => ({
    date,
    segments: rows
      .map((r, i) => {
        const point = r.dailySeries.find((d) => d.date === date);
        return {
          project: r.projectKey,
          color: colorOf(r.projectKey, i),
          commits: point?.commits ?? 0,
          loc: point?.locChanged ?? 0,
        };
      })
      .filter((s) => s.commits > 0),
  }));

  const maxTotal = Math.max(
    1,
    ...perDay.map((d) => d.segments.reduce((s, x) => s + x.commits, 0)),
  );
  const anyData = perDay.some((d) => d.segments.length > 0);
  if (!anyData) {
    return (
      <p className="py-6 text-center text-sm text-slate-400">
        No commits in this window.
      </p>
    );
  }

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const step = plotW / days.length;
  const barW = Math.max(2, step * 0.65);
  const x = (i: number) => PAD.left + i * step + (step - barW) / 2;
  const yScale = (v: number) => (v / maxTotal) * plotH;

  const labelEvery = Math.max(1, Math.ceil(days.length / 6));
  const yTicks = ticks(maxTotal);

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
              y1={PAD.top + plotH - yScale(t)}
              y2={PAD.top + plotH - yScale(t)}
              className="stroke-slate-100"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={PAD.top + plotH - yScale(t) + 3}
              textAnchor="end"
              className="fill-slate-400 text-[10px]"
            >
              {t}
            </text>
          </g>
        ))}

        {perDay.map((d, i) => {
          let yCursor = PAD.top + plotH;
          return d.segments.map((s) => {
            const h = yScale(s.commits);
            yCursor -= h;
            return (
              <rect
                key={`${d.date}-${s.project}`}
                x={x(i)}
                y={yCursor}
                width={barW}
                height={h}
                rx={1}
                fill={s.color}
              >
                <title>
                  {d.date} · {s.project} · {s.commits} commit
                  {s.commits === 1 ? '' : 's'} · {s.loc} LOC
                </title>
              </rect>
            );
          });
        })}

        {days.map((date, i) =>
          i % labelEvery === 0 || i === days.length - 1 ? (
            <text
              key={`label-${date}`}
              x={x(i) + barW / 2}
              y={H - 8}
              textAnchor="middle"
              className="fill-slate-400 text-[10px]"
            >
              {date.slice(5)}
            </text>
          ) : null,
        )}
      </svg>

      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        {projects.map((p, i) => (
          <span key={p} className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-sm"
              style={{ backgroundColor: colorOf(p, i) }}
            />
            {p}
          </span>
        ))}
        <span className="ml-auto text-slate-400">
          stacked commits/day · hover for exact values
        </span>
      </div>
    </div>
  );
}

function buildWindow(windowDays: number): string[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const out: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    out.push(new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function ticks(max: number): number[] {
  if (max <= 3) {
    return Array.from({ length: max + 1 }, (_, i) => i);
  }
  const step = Math.ceil(max / 3);
  const out: number[] = [];
  for (let t = 0; t <= max; t += step) {
    out.push(t);
  }
  return out;
}
