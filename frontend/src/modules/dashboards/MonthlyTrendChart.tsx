import { useState, type MouseEvent } from 'react';
import { istTodayKey } from '../../lib/utils';
import {
  CHART_PAD,
  MONTH_LABEL_SLOT_PX,
  MONTH_LABEL_STACKED_SLOT_PX,
  STACKED_LABEL_EXTRA_PX,
  axisLabelIndices,
  monthLongLabel,
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
 * reader do that differencing by eye.
 *
 * One metric at a time, which is what the toggle buys: the axis is absolute
 * and labelled in the metric's own units. Both axes are titled (2026-11-11),
 * and hovering a month shows its figures.
 */
export type TrendMetric = 'commits' | 'loc';

const H = 256;

const MONTHLY_Y_TITLE: Record<TrendMetric, string> = {
  commits: 'Commits per month',
  loc: 'Lines changed per month (added + removed)',
};
const MONTHLY_X_TITLE = 'Month (IST)';

export function MonthlyTrendChart({
  months,
  metric,
}: {
  months: TrendMonth[];
  metric: TrendMetric;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [hovered, setHovered] = useState<number | null>(null);

  const value = (m: TrendMonth) =>
    metric === 'commits' ? m.commits : m.locChanged;

  // Scaled over collected months only. An uncollected month reports zero, and
  // letting that zero into the maximum is harmless — but letting it into the
  // *scale* of a chart that never draws it is not, and it would compress the
  // real months when a partial month happens to be the largest.
  const measured = months.filter((m) => m.collected);
  const ticks = trendTicks(Math.max(0, ...measured.map(value)));
  const top = ticks[ticks.length - 1];

  // Every month label carries its year ("Sep 2026"). Where twelve of those do
  // not fit side by side, each one stacks — month over year — rather than
  // the axis dropping months; only on a phone-width chart does it thin.
  const inlineFits =
    (width - CHART_PAD.left - CHART_PAD.right) / Math.max(1, months.length) >=
    MONTH_LABEL_SLOT_PX;
  const box = plotBox(width, H, inlineFits ? 0 : STACKED_LABEL_EXTRA_PX);
  // Half a step in from each edge, so the first and last markers are not
  // sitting on the axis line.
  const step = box.plotW / months.length;
  const x = (i: number) => box.left + i * step + step / 2;
  const y = (v: number) => box.top + box.plotH - (v / top) * box.plotH;

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

  if (runs.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-fg-faint">
        No collected months in the last year yet — the backfill has not reached
        this far.
      </p>
    );
  }

  const lineTone = metric === 'commits' ? 'stroke-chart-1' : 'stroke-chart-2';
  // Class names are written out rather than composed, so Tailwind's scanner
  // can see them: a class built by joining a prefix to a variable compiles to
  // nothing and the mark loses its colour. The design-system suite enforces
  // this repo-wide.
  const solidTone = metric === 'commits' ? 'fill-chart-1' : 'fill-chart-2';

  const shown = axisLabelIndices(
    months.length,
    box.plotW,
    inlineFits ? MONTH_LABEL_SLOT_PX : MONTH_LABEL_STACKED_SLOT_PX,
  );
  const xLabels = shown.map((i) => {
    const label = monthAxisLabel(months[i].month);
    const [name, year] = label.split(' ');
    return {
      key: months[i].month,
      x: x(i),
      ...(inlineFits ? { text: label } : { text: name, sub: year }),
      muted: !months[i].collected,
    };
  });

  const onMove = (e: MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect) return;
    setHovered(slotAt(e.clientX - rect.left, box.left, step, months.length, true));
  };

  const hoverMonth = hovered !== null ? months[hovered] : null;

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHovered(null)}>
      <svg
        width={width}
        height={H}
        viewBox={`0 0 ${width} ${H}`}
        className="block w-full"
        role="img"
        aria-label={`${MONTHLY_Y_TITLE[metric]}, last 12 months, by month (IST)`}
      >
        {/* The uncollected span, drawn behind everything as absence rather
            than as a value. */}
        {gaps.map((run) => (
          <rect
            key={run[0].point.month}
            x={box.left + run[0].index * step}
            y={box.top}
            width={run.length * step}
            height={box.plotH}
            className="fill-chart-empty"
            opacity={0.55}
          >
            <title>
              Not collected — the backfill has not walked this far yet
            </title>
          </rect>
        ))}

        <YAxis box={box} ticks={ticks} y={y} title={MONTHLY_Y_TITLE[metric]} />

        {hovered !== null && <Crosshair box={box} x={x(hovered)} />}

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
            className={lineTone}
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
            className={lineTone}
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
          // ONE string, not sibling JSX children: `<title>` accepts a single
          // text child, and an array warns and does not hydrate reliably.
          const tooltip =
            `${monthAxisLabel(p.point.month)}` +
            `${isPartial ? ' (month to date)' : ''} · ` +
            `${p.point.commits.toLocaleString()} commit${p.point.commits === 1 ? '' : 's'} · ` +
            `${p.point.locChanged.toLocaleString()} LOC changed`;
          return (
            <circle
              key={p.point.month}
              cx={x(p.index)}
              cy={y(value(p.point))}
              r={3.5}
              // The page background, so the ring reads as hollow rather than
              // as a differently-coloured dot.
              fill={isPartial ? 'rgb(var(--surface))' : undefined}
              strokeWidth={isPartial ? 2 : 0}
              className={isPartial ? lineTone : solidTone}
            >
              <title>{tooltip}</title>
            </circle>
          );
        })}

        {hoverMonth && hovered !== null && hoverMonth.collected && (
          <HoverDot cx={x(hovered)} cy={y(value(hoverMonth))} tone={solidTone} />
        )}

        <XAxis box={box} labels={xLabels} title={MONTHLY_X_TITLE} />

        {/* One hover surface over the plot: the nearest month follows the
            pointer, so the small markers are not the only target. */}
        <rect
          x={box.left}
          y={box.top}
          width={box.plotW}
          height={box.plotH}
          fill="transparent"
          onMouseMove={onMove}
          data-hover-surface
        />
      </svg>

      {hoverMonth && hovered !== null && (
        <ChartTooltip
          box={box}
          x={x(hovered)}
          heading={
            monthLongLabel(hoverMonth.month) +
            (hoverMonth.month === partialMonth ? ' (month to date)' : '')
          }
          rows={
            hoverMonth.collected
              ? [
                  {
                    key: 'commits',
                    label: 'Commits',
                    value: hoverMonth.commits.toLocaleString('en-US'),
                    swatch: 'bg-chart-1',
                    emphasis: metric === 'commits',
                  },
                  {
                    key: 'loc',
                    label: 'Lines changed',
                    value: hoverMonth.locChanged.toLocaleString('en-US'),
                    swatch: 'bg-chart-2',
                    emphasis: metric === 'loc',
                  },
                ]
              : [{ key: 'none', label: 'Not collected yet', value: '—' }]
          }
        />
      )}
    </div>
  );
}
