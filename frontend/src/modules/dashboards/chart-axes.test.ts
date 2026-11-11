import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { istDayAxis } from '../../lib/utils';
import {
  axisLabelIndices,
  dayAxisLabel,
  dayLongLabel,
  dayWithYearLabel,
  monthLongLabel,
  slotAt,
} from './chart-axes';
import { CommitChart } from './CommitChart';
import { MonthlyTrendChart } from './MonthlyTrendChart';
import { ProjectActivityChart } from './ProjectActivityChart';
import type { TrendMonth } from './monthly-trend';
import type { ProjectActivityRow } from './useInsights';
import { BarList } from './widgets';

describe('axisLabelIndices', () => {
  it('labels every point when they all fit', () => {
    expect(axisLabelIndices(7, 660, 52)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('thins a long axis so labels never collide, always keeping the last', () => {
    const shown = axisLabelIndices(90, 660, 52);
    expect(shown[0]).toBe(0);
    expect(shown[shown.length - 1]).toBe(89);
    // No two labels closer than one slot.
    const step = 660 / 90;
    for (let i = 1; i < shown.length; i++) {
      expect((shown[i] - shown[i - 1]) * step).toBeGreaterThanOrEqual(52 / 2);
    }
    expect(shown.length).toBeLessThanOrEqual(Math.floor(660 / 52) + 1);
  });

  it('thins more on a narrow (phone-width) chart', () => {
    expect(axisLabelIndices(7, 280, 52).length).toBeLessThan(7);
  });

  it('handles empty and single-point axes', () => {
    expect(axisLabelIndices(0, 660, 52)).toEqual([]);
    expect(axisLabelIndices(1, 660, 52)).toEqual([0]);
  });
});

describe('date labels', () => {
  it('names the day and month unambiguously, not MM-DD', () => {
    expect(dayAxisLabel('2026-10-14')).toBe('14 Oct');
    expect(dayAxisLabel('2026-10-04', '2026-10-01')).toBe('4 Oct');
  });

  it('adds the year only when it turns over', () => {
    expect(dayAxisLabel('2027-01-02', '2026-12-30')).toBe('2 Jan 27');
  });

  it('spells out tooltip headings', () => {
    expect(dayLongLabel('2026-10-14')).toBe('Wed 14 Oct 2026');
    expect(monthLongLabel('2026-10')).toBe('October 2026');
    expect(dayWithYearLabel('2026-11-08')).toBe('8 Nov 2026');
    expect(dayWithYearLabel('not-a-date')).toBe('not-a-date');
  });
});

describe('slotAt', () => {
  it('maps a pointer to the centred slot under it', () => {
    expect(slotAt(46 + 5, 46, 55, 12, true)).toBe(0);
    expect(slotAt(46 + 55 * 11 + 1, 46, 55, 12, true)).toBe(11);
    expect(slotAt(10, 46, 55, 12, true)).toBeNull();
  });

  it('maps a pointer to the nearest edge-aligned point', () => {
    expect(slotAt(46 + 60, 46, 100, 7, false)).toBe(1);
    expect(slotAt(46 + 40, 46, 100, 7, false)).toBe(0);
  });
});

/** Every chart says what both of its axes are. */
describe('axis titles', () => {
  const titles = (svg: string) => ({
    y: svg.match(/data-axis="y-title">([^<]+)</)?.[1],
    x: svg.match(/data-axis="x-title">([^<]+)</)?.[1],
  });

  it('daily chart: quantity per day on Y, IST date on X, for both metrics', () => {
    const series = [{ date: '2026-10-13', commits: 2, locChanged: 300 }];
    const render = (metric: 'loc' | 'commits') =>
      renderToStaticMarkup(
        createElement(CommitChart, { series, windowDays: 3, endKey: '2026-10-13', metric }),
      );
    expect(titles(render('loc'))).toEqual({
      y: 'Lines changed per day (added + removed)',
      x: 'Date (IST)',
    });
    expect(titles(render('commits'))).toEqual({ y: 'Commits per day', x: 'Date (IST)' });
    expect(render('loc')).toContain('>13 Oct<');
  });

  it('12-month trend: quantity per month on Y, IST month on X', () => {
    const months: TrendMonth[] = ['2026-09', '2026-10'].map((month) => ({
      month,
      commits: 5,
      additions: 50,
      deletions: 0,
      locChanged: 50,
      collected: true,
    }));
    const svg = renderToStaticMarkup(
      createElement(MonthlyTrendChart, { months, metric: 'commits' }),
    );
    expect(titles(svg)).toEqual({ y: 'Commits per month', x: 'Month (IST)' });
  });

  it('project chart: lines changed per day on Y, IST date on X', () => {
    const today = istDayAxis(1)[0];
    const rows = [
      {
        projectKey: 'APP',
        commits: 1,
        locChanged: 10,
        additions: 10,
        deletions: 0,
        activeRepos: 1,
        topRepo: null,
        contributors: 1,
        dailySeries: [{ date: today, commits: 1, locChanged: 10 }],
      } as ProjectActivityRow,
    ];
    const svg = renderToStaticMarkup(
      createElement(ProjectActivityChart, { rows, windowDays: 7 }),
    );
    expect(titles(svg)).toEqual({
      y: 'Lines changed per day (added + removed)',
      x: 'Date (IST)',
    });
  });
});

describe('BarList columns', () => {
  it('heads the label and value columns when given', () => {
    const html = renderToStaticMarkup(
      createElement(BarList, {
        rows: [{ label: 'High', value: 3 }],
        columns: { label: 'Priority', value: 'Bugs' },
      }),
    );
    expect(html).toContain('>Priority<');
    expect(html).toContain('>Bugs<');
  });

  it('shows no header over an empty list', () => {
    const html = renderToStaticMarkup(
      createElement(BarList, { rows: [], columns: { label: 'Priority', value: 'Bugs' } }),
    );
    expect(html).not.toContain('>Priority<');
  });
});
