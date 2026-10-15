import type { ActivityDay } from '../useInsights';
import type { TrendMetric } from '../MonthlyTrendChart';

/**
 * Whether every day in the response carries the per-day LOC fields.
 *
 * All or nothing: a mixed response would draw some bars in lines and some in
 * commits on one axis. An API deployed before the fields existed sends none,
 * and the chart must then read in commits whatever the toggle says.
 */
export function hasDailyLoc(days: ActivityDay[]): boolean {
  return days.length > 0 && days.every((d) => typeof d.locChanged === 'number');
}

/** The metric the daily chart actually draws: the reader's choice, when the data can honour it. */
export function timelineMetric(
  days: ActivityDay[],
  requested: TrendMetric,
): TrendMetric {
  return requested === 'loc' && hasDailyLoc(days) ? 'loc' : 'commits';
}

/** One day's bar value in the drawn metric. */
export function timelineValue(day: ActivityDay, metric: TrendMetric): number {
  return metric === 'loc' ? (day.locChanged ?? 0) : day.totalCommits;
}
