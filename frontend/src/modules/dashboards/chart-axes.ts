/**
 * Pure layout helpers shared by the dashboard line charts (CommitChart,
 * MonthlyTrendChart, ProjectActivityChart). Kept free of React so they are
 * unit-tested directly.
 *
 * The charts draw at the container's measured pixel width (see `ChartFrame`),
 * so every size here is a real CSS pixel: an 11px label stays 11px on a phone
 * and on a wide monitor, instead of scaling with a fixed viewBox.
 */

/** Axis tick and axis-title text size, in px. */
export const AXIS_FONT_PX = 11;

/** Width the charts lay out at before the container has been measured (SSR, tests). */
export const FALLBACK_CHART_WIDTH = 720;

/**
 * Space around the plot. `top` holds the Y-axis title; `bottom` holds the X
 * tick labels and, under them, the X-axis title; `left` holds the Y tick labels.
 */
export const CHART_PAD = { top: 26, right: 14, bottom: 44, left: 46 } as const;

/** Baselines, measured down from the plot's bottom edge. */
export const X_TICK_OFFSET = 16;
export const X_TITLE_OFFSET = 36;

/** Rough rendered width of a day label ("14 Oct") plus breathing room. */
export const DAY_LABEL_SLOT_PX = 52;
/** Rough rendered width of a month label ("Sep 2026") plus breathing room. */
export const MONTH_LABEL_SLOT_PX = 58;
/** The same label stacked on two lines ("Sep" over "2026"), for narrow charts. */
export const MONTH_LABEL_STACKED_SLOT_PX = 34;
/** Extra bottom space a stacked (two-line) tick label needs. */
export const STACKED_LABEL_EXTRA_PX = 13;

export interface PlotBox {
  width: number;
  height: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  plotW: number;
  plotH: number;
}

/** `extraBottom` reserves room under the plot for two-line tick labels. */
export function plotBox(width: number, height: number, extraBottom = 0): PlotBox {
  const left = CHART_PAD.left;
  const top = CHART_PAD.top;
  const right = width - CHART_PAD.right;
  const bottom = height - CHART_PAD.bottom - extraBottom;
  return {
    width,
    height,
    left,
    top,
    right,
    bottom,
    plotW: Math.max(1, right - left),
    plotH: Math.max(1, bottom - top),
  };
}

/**
 * Which of `count` evenly spaced x positions get a tick label so no two
 * labels collide in `plotW` pixels.
 *
 * Every `stride`-th label from the first, plus the last one, so the reader
 * always sees where the axis ends. When the last would crowd its neighbour,
 * the neighbour gives way, never the last.
 */
export function axisLabelIndices(
  count: number,
  plotW: number,
  slotPx: number,
): number[] {
  if (count <= 0) return [];
  const fits = Math.max(2, Math.floor(plotW / slotPx));
  if (count <= fits) return Array.from({ length: count }, (_, i) => i);

  const stride = Math.ceil(count / fits);
  const indices: number[] = [];
  for (let i = 0; i < count; i += stride) indices.push(i);
  const last = count - 1;
  if (indices[indices.length - 1] !== last) {
    // Closer than half a stride to the end: drop the neighbour to make room.
    if (last - indices[indices.length - 1] < Math.ceil(stride / 2)) {
      indices.pop();
    }
    indices.push(last);
  }
  return indices;
}

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A `YYYY-MM-DD` day as an axis label: `14 Oct`, or `2 Jan 27` when the year
 * differs from the previously *shown* label's.
 *
 * Written out rather than `toLocaleDateString` for the reason `formatCompact`
 * is: a label whose shape changes with the browser's locale (`10/14` vs
 * `14/10`) is the ambiguity this replaces.
 */
export function dayAxisLabel(day: string, previousShown?: string): string {
  const [year, month, date] = day.split('-');
  const base = `${Number(date)} ${MONTHS_SHORT[Number(month) - 1]}`;
  const turnsOver = previousShown !== undefined && previousShown.slice(0, 4) !== year;
  return turnsOver ? `${base} ${year.slice(2)}` : base;
}

/** A `YYYY-MM-DD` day with its year: `3 Nov 2026`. Anything else is returned unchanged. */
export function dayWithYearLabel(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const [year, month, date] = day.split('-');
  return `${Number(date)} ${MONTHS_SHORT[Number(month) - 1]} ${year}`;
}

/** A `YYYY-MM-DD` day in full for a tooltip heading: `Tue 14 Oct 2026`. */
export function dayLongLabel(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  // Noon UTC, so the weekday cannot slip a day in any time zone.
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, date, 12)).getUTCDay()];
  return `${weekday} ${date} ${MONTHS_SHORT[month - 1]} ${year}`;
}

/** A `YYYY-MM` month in full for a tooltip heading: `October 2026`. */
export function monthLongLabel(month: string): string {
  const [year, index] = month.split('-');
  return `${MONTHS_LONG[Number(index) - 1]} ${year}`;
}

/**
 * The index of the slot under a pointer `px` pixels from the chart's left
 * edge, for slots of width `step` starting at `left` (`centered`: points sit
 * mid-slot; otherwise on slot boundaries, first point at `left`).
 */
export function slotAt(
  px: number,
  left: number,
  step: number,
  count: number,
  centered: boolean,
): number | null {
  if (count === 0 || step <= 0) return count === 1 ? 0 : null;
  const raw = centered ? Math.floor((px - left) / step) : Math.round((px - left) / step);
  if (raw < 0 || raw >= count) return null;
  return raw;
}
