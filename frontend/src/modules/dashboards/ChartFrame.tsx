import type { ReactNode } from 'react';
import { cn, formatCompact } from '../../lib/utils';
import {
  AXIS_FONT_PX,
  CHART_PAD,
  X_TICK_OFFSET,
  X_TITLE_OFFSET,
  type PlotBox,
} from './chart-axes';

const CHART_PAD_BOTTOM = CHART_PAD.bottom;

/**
 * Shared anatomy for the dashboard line charts: labelled axes, a hover
 * crosshair and an HTML tooltip (DESIGN-SYSTEM.md §Charts). The charts draw at
 * their container's measured width (`use-measured-width.ts`), so every size
 * here is a real pixel.
 *
 * Every chart says what both axes are. The Y title sits above the tick labels,
 * horizontal, where it is read before the numbers it explains; the X title is
 * centred under the tick labels.
 */

/** Horizontal gridlines with their values, and the Y-axis title above them. */
export function YAxis({
  box,
  ticks,
  y,
  title,
}: {
  box: PlotBox;
  ticks: number[];
  y: (v: number) => number;
  title: string;
}) {
  return (
    <g>
      <text
        x={4}
        y={12}
        className="fill-fg-muted font-medium"
        style={{ fontSize: AXIS_FONT_PX }}
        data-axis="y-title"
      >
        {title}
      </text>
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={box.left}
            x2={box.right}
            y1={y(t)}
            y2={y(t)}
            className="stroke-chart-grid"
            strokeWidth={1}
          />
          <text
            x={box.left - 8}
            y={y(t) + 4}
            textAnchor="end"
            className="fill-chart-axis tabular-nums"
            style={{ fontSize: AXIS_FONT_PX }}
          >
            {formatCompact(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

/**
 * The X tick labels under the plot and the X-axis title under them. A label
 * with `sub` is drawn on two lines (`text` over `sub`) — the caller reserves
 * the room with `plotBox(…, STACKED_LABEL_EXTRA_PX)`. The title always sits
 * on the chart's bottom edge, so it clears either form.
 */
export function XAxis({
  box,
  labels,
  title,
}: {
  box: PlotBox;
  labels: { key: string; x: number; text: string; sub?: string; muted?: boolean }[];
  title: string;
}) {
  return (
    <g>
      {labels.map((l) => (
        <text
          key={l.key}
          x={l.x}
          y={box.bottom + X_TICK_OFFSET}
          textAnchor="middle"
          className={cn('fill-chart-axis', l.muted && 'opacity-50')}
          style={{ fontSize: AXIS_FONT_PX }}
        >
          {l.sub ? (
            <>
              <tspan x={l.x}>{l.text}</tspan>
              <tspan x={l.x} dy={13}>
                {l.sub}
              </tspan>
            </>
          ) : (
            l.text
          )}
        </text>
      ))}
      <text
        x={box.left + box.plotW / 2}
        y={box.height - (CHART_PAD_BOTTOM - X_TITLE_OFFSET)}
        textAnchor="middle"
        className="fill-fg-muted font-medium"
        style={{ fontSize: AXIS_FONT_PX }}
        data-axis="x-title"
      >
        {title}
      </text>
    </g>
  );
}

/** The vertical guide at the hovered position. */
export function Crosshair({ box, x }: { box: PlotBox; x: number }) {
  return (
    <line
      x1={x}
      x2={x}
      y1={box.top}
      y2={box.bottom}
      className="stroke-chart-axis"
      strokeWidth={1}
      opacity={0.6}
      pointerEvents="none"
    />
  );
}

/** The hovered point, ringed in the surface colour so it reads over the line. */
export function HoverDot({ cx, cy, tone }: { cx: number; cy: number; tone: string }) {
  return (
    <circle
      cx={cx}
      cy={cy}
      r={5}
      className={tone}
      stroke="rgb(var(--surface))"
      strokeWidth={2}
      pointerEvents="none"
    />
  );
}

export interface TooltipRow {
  key: string;
  label: string;
  value: string;
  /** `bg-chart-N` swatch; text never wears the series colour. */
  swatch?: string;
  /** The quantity the chart is currently drawing, set in the primary ink. */
  emphasis?: boolean;
}

/**
 * Floating readout for the hovered position. Positioned in the chart's own
 * pixel space (the SVG draws 1:1), flipped to the left of the guide past the
 * middle so it never runs off the card.
 */
export function ChartTooltip({
  box,
  x,
  heading,
  rows,
  footer,
}: {
  box: PlotBox;
  x: number;
  heading: string;
  rows: TooltipRow[];
  footer?: ReactNode;
}) {
  const flip = x > box.width / 2;
  // Never wider than the room beside the guide, so it stays on the card at
  // phone width.
  const room = (flip ? x : box.width - x) - 14;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-lg"
      style={{
        top: box.top,
        maxWidth: Math.max(120, Math.min(256, room)),
        minWidth: Math.min(160, Math.max(120, room)),
        ...(flip ? { right: box.width - x + 10 } : { left: x + 10 }),
      }}
    >
      <div className="mb-1 font-medium text-fg">{heading}</div>
      <dl className="space-y-0.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-3">
            <dt className="flex min-w-0 items-center gap-1.5 text-fg-muted">
              {r.swatch && (
                <span className={cn('h-2 w-2 shrink-0 rounded-sm', r.swatch)} />
              )}
              <span className="truncate">{r.label}</span>
            </dt>
            <dd
              className={cn(
                'tabular-nums',
                r.emphasis ? 'font-semibold text-fg' : 'text-fg-secondary',
              )}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      {footer && <div className="mt-1.5 text-fg-faint">{footer}</div>}
    </div>
  );
}
