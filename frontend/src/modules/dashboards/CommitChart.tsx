/**
 * GitHub-style daily contribution chart (dependency-free SVG): one column per
 * day across the FULL window — zero-commit days included, unlike a sparse list —
 * with a relative LOC overlay line. Native <title> tooltips carry exact values.
 */
interface DayPoint {
  date: string; // YYYY-MM-DD
  commits: number;
  locChanged: number;
}

const W = 720;
const H = 180;
const PAD = { top: 12, right: 8, bottom: 26, left: 30 };

export function CommitChart({
  series,
  windowDays,
}: {
  series: DayPoint[]; // sparse: only days with commits
  windowDays: number;
}) {
  const days = buildFullWindow(series, windowDays);
  const maxCommits = Math.max(1, ...days.map((d) => d.commits));
  const maxLoc = Math.max(1, ...days.map((d) => d.locChanged));
  const total = days.reduce((s, d) => s + d.commits, 0);

  if (total === 0) {
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

  const yCommits = (v: number) => PAD.top + plotH - (v / maxCommits) * plotH;
  const yLoc = (v: number) => PAD.top + plotH - (v / maxLoc) * plotH;
  const x = (i: number) => PAD.left + i * step + (step - barW) / 2;

  const locLine = days
    .map((d, i) => `${(x(i) + barW / 2).toFixed(1)},${yLoc(d.locChanged).toFixed(1)}`)
    .join(' ');

  // Sparse x labels: first, last, and roughly weekly in between.
  const labelEvery = Math.max(1, Math.ceil(days.length / 6));
  const yTicks = commitTicks(maxCommits);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Commits per day"
      >
        {/* y grid + labels (commits scale) */}
        {yTicks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={yCommits(t)}
              y2={yCommits(t)}
              className="stroke-slate-100"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={yCommits(t) + 3}
              textAnchor="end"
              className="fill-slate-400 text-[10px]"
            >
              {t}
            </text>
          </g>
        ))}

        {/* commit bars */}
        {days.map((d, i) => (
          <rect
            key={d.date}
            x={x(i)}
            y={yCommits(d.commits)}
            width={barW}
            height={PAD.top + plotH - yCommits(d.commits)}
            rx={1.5}
            className={d.commits > 0 ? 'fill-brand' : 'fill-slate-100'}
          >
            <title>
              {d.date} · {d.commits} commit{d.commits === 1 ? '' : 's'} ·{' '}
              {d.locChanged} LOC
            </title>
          </rect>
        ))}

        {/* LOC overlay (relative scale) */}
        <polyline
          points={locLine}
          fill="none"
          className="stroke-emerald-500"
          strokeWidth={1.5}
          strokeLinejoin="round"
          opacity={0.85}
        />

        {/* x labels */}
        {days.map((d, i) =>
          i % labelEvery === 0 || i === days.length - 1 ? (
            <text
              key={`label-${d.date}`}
              x={x(i) + barW / 2}
              y={H - 8}
              textAnchor="middle"
              className="fill-slate-400 text-[10px]"
            >
              {d.date.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      <div className="mt-1 flex items-center gap-4 text-xs text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-brand" /> commits
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-emerald-500" /> changed LOC
          (relative scale)
        </span>
        <span className="ml-auto">hover a bar for exact values</span>
      </div>
    </div>
  );
}

/** Fill the sparse series into a contiguous [today-windowDays+1 … today] range. */
function buildFullWindow(series: DayPoint[], windowDays: number): DayPoint[] {
  const byDate = new Map(series.map((d) => [d.date, d]));
  const out: DayPoint[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = windowDays - 1; i >= 0; i--) {
    const day = new Date(today.getTime() - i * 86_400_000);
    const date = day.toISOString().slice(0, 10);
    out.push(byDate.get(date) ?? { date, commits: 0, locChanged: 0 });
  }
  return out;
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
