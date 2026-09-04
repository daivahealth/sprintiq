import { describe, expect, it } from 'vitest';
import {
  collectedRuns,
  monthAxisLabel,
  splitProvisional,
  trendTicks,
  type TrendMonth,
} from './monthly-trend';

function month(m: string, collected = true, commits = 1): TrendMonth {
  return {
    month: m,
    commits,
    additions: 0,
    deletions: 0,
    locChanged: 0,
    collected,
  };
}

/**
 * The chart's break at the backfill edge.
 *
 * A month collection never reached yields zero, and a zero plotted on a
 * continuous line asserts nobody committed — a claim the data does not make.
 * The line is therefore drawn as one polyline per contiguous run of collected
 * months, so the gap is structural rather than something painted over a point
 * that is already on the path.
 */
describe('collectedRuns', () => {
  it('returns one run when every month was collected', () => {
    const runs = collectedRuns([month('2026-01'), month('2026-02')]);
    expect(runs).toHaveLength(1);
    expect(runs[0].map((p) => p.point.month)).toEqual(['2026-01', '2026-02']);
  });

  it('drops a leading uncollected stretch instead of anchoring the line at zero', () => {
    // The common case: a year-long axis over a backfill that has walked six
    // months. Starting the path at the first uncollected month would draw a
    // climb out of zero that is pure collection lag.
    const runs = collectedRuns([
      month('2026-01', false),
      month('2026-02', false),
      month('2026-03'),
      month('2026-04'),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0].map((p) => p.point.month)).toEqual(['2026-03', '2026-04']);
  });

  it('splits into separate runs around a gap in the middle', () => {
    const runs = collectedRuns([
      month('2026-01'),
      month('2026-02', false),
      month('2026-03'),
    ]);

    expect(runs.map((r) => r.map((p) => p.point.month))).toEqual([
      ['2026-01'],
      ['2026-03'],
    ]);
  });

  it('keeps each point’s position on the full axis, so a gap leaves a gap', () => {
    // The index is the x-position. If a run renumbered from zero, the months
    // after a gap would slide left and the chart would silently compress a
    // year into however much of it was collected.
    const runs = collectedRuns([
      month('2026-01', false),
      month('2026-02'),
      month('2026-03'),
    ]);

    expect(runs[0].map((p) => p.index)).toEqual([1, 2]);
  });

  it('returns no runs when nothing was collected', () => {
    expect(collectedRuns([month('2026-01', false)])).toEqual([]);
  });
});

/**
 * Y-axis ticks. Unlike the daily chart's LOC overlay — which is drawn on a
 * "relative scale" because it shares an axis with commits — this chart shows
 * one metric at a time, so the axis is absolute and its ticks have to be
 * readable at both scales: single-digit commits and six-figure LOC.
 */
describe('trendTicks', () => {
  it('gives every integer up to a small maximum, never a fractional commit', () => {
    // "2.5 commits" is not a quantity that exists.
    expect(trendTicks(3)).toEqual([0, 1, 2, 3]);
  });

  it('always starts at zero, so bar height and line height mean the same thing', () => {
    expect(trendTicks(4200)[0]).toBe(0);
    expect(trendTicks(7)[0]).toBe(0);
  });

  it('covers the maximum, so the highest point is never drawn off the top', () => {
    for (const max of [1, 9, 17, 240, 4200, 98_765]) {
      const ticks = trendTicks(max);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
    }
  });

  it('rounds to human intervals rather than to the data’s exact maximum', () => {
    // A top tick of 4,237 is an axis nobody can read across.
    expect(trendTicks(4237)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
  });

  it('divides a millions-scale LOC axis at 5M, not in two jumps of 10M', () => {
    // The reported case. A 20M axis drawn as 0 / 10M / 20M has two intervals,
    // so every month lands in the middle band and the chart stops resolving
    // the differences it exists to show.
    expect(trendTicks(20_000_000)).toEqual([
      0, 5_000_000, 10_000_000, 15_000_000, 20_000_000,
    ]);
  });

  it('never returns fewer than four intervals, at any scale', () => {
    // The coarseness bug was not specific to millions: it appeared wherever
    // the rounded step happened to overshoot, which the old ladder did in a
    // band below every power of ten.
    for (const max of [9, 17, 240, 4237, 98_765, 12_000_000, 20_000_000]) {
      expect(trendTicks(max).length - 1).toBeGreaterThanOrEqual(4);
    }
  });

  it('keeps the axis readable by not overshooting into a wall of gridlines', () => {
    for (const max of [9, 17, 240, 4237, 98_765, 12_000_000, 20_000_000]) {
      expect(trendTicks(max).length - 1).toBeLessThanOrEqual(6);
    }
  });

  it('steps by whole numbers, so no gridline claims half a commit', () => {
    // 1.5 and 2.5 are fine multipliers at thousands but not at units, where
    // they label a gridline with a quantity that cannot occur.
    for (const max of [5, 7, 9, 17]) {
      for (const tick of trendTicks(max)) {
        expect(Number.isInteger(tick)).toBe(true);
      }
    }
  });

  it('handles an all-zero window without collapsing the axis', () => {
    // Max 0 must still produce a drawable axis, not a divide-by-zero.
    const ticks = trendTicks(0);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThan(0);
  });
});

describe('monthAxisLabel', () => {
  it('names the month short, with the year only where it turns over', () => {
    // Twelve labels on one axis: repeating the year on each is noise, but
    // dropping it entirely makes a 12-month axis ambiguous about which
    // January it starts in.
    expect(monthAxisLabel('2026-03', '2026-02')).toBe('Mar');
    expect(monthAxisLabel('2026-01', '2025-12')).toBe('Jan 26');
  });

  it('labels the first month with its year, having nothing before it', () => {
    expect(monthAxisLabel('2025-10', undefined)).toBe('Oct 25');
  });
});

/**
 * The month still in progress.
 *
 * The API's window always ends with the current IST month, which on the 3rd is
 * three days of data drawn the same width as thirty. On real numbers that put
 * 177 commits next to a ~4,000 baseline and the line dived to the floor — a
 * calendar artifact that reads as a collapse in delivery.
 *
 * The same error the backfill floor is guarded against at the other end of the
 * axis: a partial month drawn as a whole one. Here the point is kept rather
 * than dropped, and marked provisional instead.
 */
describe('splitProvisional', () => {
  const runs = () =>
    collectedRuns([
      month('2026-07'),
      month('2026-08'),
      month('2026-09'),
    ]);

  it('peels the in-progress month off the solid path', () => {
    const { solid } = splitProvisional(runs(), '2026-09');
    expect(solid.map((r) => r.map((p) => p.point.month))).toEqual([
      ['2026-07', '2026-08'],
    ]);
  });

  it('returns the provisional link as the last complete month plus the partial one', () => {
    // Two points, because a dashed segment needs somewhere to start: the
    // reader has to see the line reach the provisional value, not just a
    // marker floating clear of the path.
    const { provisional } = splitProvisional(runs(), '2026-09');
    expect(provisional?.map((p) => p.point.month)).toEqual([
      '2026-08',
      '2026-09',
    ]);
  });

  it('leaves the path untouched when no month is in progress', () => {
    const { solid, provisional } = splitProvisional(runs(), null);
    expect(solid.map((r) => r.length)).toEqual([3]);
    expect(provisional).toBeNull();
  });

  it('ignores a partial month that is not on the axis', () => {
    const { solid, provisional } = splitProvisional(runs(), '2026-12');
    expect(solid.map((r) => r.length)).toEqual([3]);
    expect(provisional).toBeNull();
  });

  it('draws no dangling link when the partial month stands alone after a gap', () => {
    // Its predecessor was never collected, so there is no measured point to
    // draw the segment from. The marker alone carries it.
    const isolated = collectedRuns([
      month('2026-07'),
      month('2026-08', false),
      month('2026-09'),
    ]);
    const { solid, provisional } = splitProvisional(isolated, '2026-09');

    expect(solid.map((r) => r.map((p) => p.point.month))).toEqual([
      ['2026-07'],
    ]);
    expect(provisional).toBeNull();
  });

  it('only ever treats the final point of a run as provisional', () => {
    // A month mid-axis cannot be in progress, and treating one as such would
    // punch a dashed hole through settled history.
    const { solid, provisional } = splitProvisional(runs(), '2026-08');
    expect(solid.map((r) => r.length)).toEqual([3]);
    expect(provisional).toBeNull();
  });
});
