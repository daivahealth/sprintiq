import { formatCompact, istTodayKey } from '../../lib/utils';
import {
  collectedRuns,
  monthAxisLabel,
  splitProvisional,
  trendTicks,
  type TrendMonth,
} from './monthly-trend';

/**
 * Twelve months of commit or changed-LOC volume as a line (dependency-free
 * SVG, same conventions as CommitChart).
 *
 * A line rather than bars because the question is the shape of a year — where
 * volume climbed, where it fell away — and twelve separated bars make the
 * reader do that differencing by eye. Bars are right for the daily chart, whose
 * columns are discrete days you click into; these are a trajectory.
 *
 * One metric at a time, which is what the toggle buys: CommitChart has to draw
 * its LOC overlay on a "relative scale" to share an axis with commits, and a
 * relative axis cannot answer "how much". Here the axis is absolute and labelled
 * in the metric's own units.
 */
export type TrendMetric = 'commits' | 'loc';

const W = 720;
const H = 220;
const PAD = { top: 14, right: 12, bottom: 30, left: 46 };

export function MonthlyTrendChart({
  months,
  metric,
}: {
  months: TrendMonth[];
  metric: TrendMetric;
}) {
  const value = (m: TrendMonth) =>
    metric === 'commits' ? m.commits : m.locChanged;

  // Scaled over collected months only. An uncollected month reports zero, and
  // letting that zero into the maximum is harmless — but letting it into the
  // *scale* of a chart that never draws it is not, and it would compress the
  // real months when a partial month happens to be the largest.
  const measured = months.filter((m) => m.collected);
  const ticks = trendTicks(Math.max(0, ...measured.map(value)));
  const top = ticks[ticks.length - 1];

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  // Half a step in from each edge, so the first and last markers are not
  // sitting on the axis line.
  const step = plotW / months.length;
  const x = (i: number) => PAD.left + i * step + step / 2;
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;

  const runs = collectedRuns(months);
  // Derived here rather than sent by the API: which month is in progress is a
  // calendar fact, and reading it off the clock means an older backend that
  // never heard of the distinction still gets the honest rendering.
  const partialMonth =
    months.find((m) => m.month === istTodayKey().slice(0, 7))?.month ?? null;
  const { solid, provisional } = splitProvisional(runs, partialMonth);
  // The same splitter with the flag inverted, so a gap anywhere on the axis is
  // shaded correctly rather than only the leading stretch the backfill
  // currently produces.
  const gaps = collectedRuns(
    months.map((m) => ({ ...m, collected: !m.collected })),
  );
  const label = metric === 'commits' ? 'Commits' : 'Lines of code changed';

  if (runs.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-fg-faint">
        No collected months in the last year yet — the backfill has not reached
        this far.
      </p>
    );
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`${label} per month, last 12 months`}
      >
        {/* The uncollected span, drawn behind everything as absence rather
            than as a value. */}
        {gaps.map((run) => (
          <rect
            key={run[0].point.month}
            x={PAD.left + run[0].index * step}
            y={PAD.top}
            width={run.length * step}
            height={plotH}
            className="fill-chart-empty"
            opacity={0.55}
          >
            <title>
              Not collected — the backfill has not walked this far yet
            </title>
          </rect>
        ))}

        {/* y grid + labels, in the metric's own units */}
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

        {/* One polyline per contiguous collected run: the break at the
            backfill edge is made of absence, not painted over a point that is
            already on the path. */}
        {solid.map((run) => (
          <polyline
            key={run[0].point.month}
            points={run
              .map((p) => `${x(p.index).toFixed(1)},${y(value(p.point)).toFixed(1)}`)
              .join(' ')}
            fill="none"
            className={metric === 'commits' ? 'stroke-chart-1' : 'stroke-chart-2'}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* The month still running, dashed: a few days of data drawn at the
            same width as thirty otherwise reads as a real fall. */}
        {provisional && (
          <polyline
            points={provisional
              .map((p) => `${x(p.index).toFixed(1)},${y(value(p.point)).toFixed(1)}`)
              .join(' ')}
            fill="none"
            className={metric === 'commits' ? 'stroke-chart-1' : 'stroke-chart-2'}
            strokeWidth={2}
            strokeDasharray="4 3"
            strokeLinecap="round"
            opacity={0.7}
          />
        )}

        {/* Markers carry the exact figures; only collected months get one, so
            there is nothing to hover on a month we did not measure. */}
        {runs.flat().map((p) => {
          // Hollow for the month in progress — the marker itself says the
          // value is not final, so the shape survives being read without the
          // caption underneath it.
          const isPartial = p.point.month === partialMonth;
          // Class names are written out rather than composed, so Tailwind's
          // scanner can see them: a stroke class built by joining a prefix to
          // a variable compiles to nothing and the marker loses its colour.
          // The design-system suite enforces this repo-wide.
          const solidTone =
            metric === 'commits' ? 'fill-chart-1' : 'fill-chart-2';
          const hollowTone =
            metric === 'commits' ? 'stroke-chart-1' : 'stroke-chart-2';
          return (
            <circle
              key={p.point.month}
              cx={x(p.index)}
              cy={y(value(p.point))}
              r={isPartial ? 3.5 : 3}
              // The page background, so the ring reads as hollow rather than
              // as a differently-coloured dot.
              fill={isPartial ? 'rgb(var(--surface))' : undefined}
              strokeWidth={isPartial ? 2 : 0}
              className={isPartial ? hollowTone : solidTone}
            >
              <title>
                {monthAxisLabel(p.point.month, undefined)}
                {isPartial ? ' (month to date)' : ''} ·{' '}
                {p.point.commits.toLocaleString()} commit
                {p.point.commits === 1 ? '' : 's'} ·{' '}
                {p.point.locChanged.toLocaleString()} LOC changed
              </title>
            </circle>
          );
        })}

        {/* x labels — twelve fit across this width, so every month is named. */}
        {months.map((m, i) => (
          <text
            key={`label-${m.month}`}
            x={x(i)}
            y={H - 10}
            textAnchor="middle"
            className={
              m.collected
                ? 'fill-chart-axis text-[10px]'
                : 'fill-chart-axis text-[10px] opacity-50'
            }
          >
            {monthAxisLabel(m.month, months[i - 1]?.month)}
          </text>
        ))}
      </svg>
    </div>
  );
}
