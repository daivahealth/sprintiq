/**
 * Pure geometry and formatting for the Overview's 12-month trend.
 *
 * Split from the component for the same reason `activity-range.ts` is: the
 * decisions worth testing here — where the line breaks, what the axis says —
 * are arithmetic, and testing them through a rendered SVG would prove only
 * that the SVG rendered.
 */

/** One month as the API hands it over (`MonthlyTrendView.months[]`). */
export interface TrendMonth {
  month: string;
  commits: number;
  additions: number;
  deletions: number;
  locChanged: number;
  collected: boolean;
}

/** A point with the x-position it holds on the FULL axis, gaps included. */
export interface TrendPoint {
  point: TrendMonth;
  index: number;
}

/**
 * Contiguous stretches of collected months, each drawn as its own polyline.
 *
 * The gap is made of absence rather than painted over a continuous path: a
 * month the backfill never reached reports zero commits, and a line drawn
 * through that zero states as fact that nobody committed. Splitting the path
 * is the only rendering where the missing month makes no claim at all.
 *
 * Positions come from the full axis, so a gap stays a gap instead of letting
 * the months after it slide left into the space.
 */
export function collectedRuns(months: TrendMonth[]): TrendPoint[][] {
  const runs: TrendPoint[][] = [];
  let run: TrendPoint[] = [];

  months.forEach((point, index) => {
    if (point.collected) {
      run.push({ point, index });
      return;
    }
    if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  });

  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * Y-axis ticks from zero to a rounded ceiling at or above `max`, in four to six
 * evenly spaced bands.
 *
 * Always anchored at zero: this chart swaps between two metrics on the same
 * frame, and an axis that floated its baseline would redraw the same volume as
 * a different shape depending on which one you were looking at.
 *
 * Small maxima get every integer, because a commit count has no fractions and
 * "2.5" on the axis of a three-commit month is not a smaller unit — it is a
 * quantity that cannot occur.
 */
export function trendTicks(max: number): number[] {
  if (max <= 4) {
    return Array.from({ length: Math.max(1, Math.ceil(max)) + 1 }, (_, i) => i);
  }

  const step = niceStep(max);
  // The ceiling is derived from the step, not from `max` plus a fudge: a
  // half-step of slack stops short whenever the rounded step overshoots the
  // raw interval, which drew the tallest month above the top gridline.
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= top; t += step) {
    ticks.push(t);
  }
  return ticks;
}

/** How many intervals the axis may be cut into before it reads as clutter. */
const MAX_INTERVALS = 6;

/**
 * The smallest readable interval that divides `max` into at most six bands.
 *
 * Chosen by the resulting tick COUNT rather than by rounding `max / 3` up to a
 * nice number, which is what made a 20M axis draw as `0 / 10M / 20M`: dividing
 * first gave a raw interval of 6.7M, and the nearest nice number above it was
 * 10M — two bands, with every month stranded in the middle one. Searching
 * upwards instead takes the *first* interval that fits, so 5M wins before 10M
 * is ever considered.
 *
 * Because each candidate is at most double the one below it, the smallest
 * fitting step always leaves at least four bands — the axis cannot come out
 * coarse at any scale.
 *
 * Steps are 1, 2 or 5 times a power of ten: the multipliers a reader adds up
 * without thinking, and the only ones that stay whole numbers all the way down
 * to units, where a 2.5 would label a gridline with half a commit.
 */
function niceStep(max: number): number {
  for (let power = 0; ; power += 1) {
    for (const factor of [1, 2, 5]) {
      const step = factor * 10 ** power;
      if (Math.ceil(max / step) <= MAX_INTERVALS) return step;
    }
  }
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * An axis label for one month, given the month before it.
 *
 * The year appears only where it changes (and on the first label, which has no
 * predecessor to have changed from). Printing it twelve times is noise;
 * printing it never leaves a year-long axis unable to say which January it
 * starts in.
 */
export function monthAxisLabel(
  month: string,
  previous: string | undefined,
): string {
  const [year, index] = month.split('-');
  const name = MONTH_NAMES[Number(index) - 1];
  const turnsOver = !previous || previous.slice(0, 4) !== year;
  return turnsOver ? `${name} ${year.slice(2)}` : name;
}
