import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MonthlyTrendChart } from './MonthlyTrendChart';
import type { TrendMonth } from './monthly-trend';

function m(month: string, commits: number, loc: number, collected = true): TrendMonth {
  return { month, commits, additions: loc, deletions: 0, locChanged: loc, collected };
}

function render(months: TrendMonth[], metric: 'commits' | 'loc') {
  return renderToStaticMarkup(
    createElement(MonthlyTrendChart, { months, metric }),
  );
}

// A realistic year: three months before the backfill floor, then nine measured.
// Deliberately anchored in the past so no month is ever the running one — the
// provisional rendering has its own fixtures below, and a window ending in the
// real current month would make these assertions shift with the calendar.
const YEAR: TrendMonth[] = [
  m('2018-10', 0, 0, false),
  m('2018-11', 0, 0, false),
  m('2018-12', 0, 0, false),
  m('2019-01', 120, 4_000_000),
  m('2019-02', 180, 6_500_000),
  m('2019-03', 90, 3_100_000),
  m('2019-04', 240, 12_000_000),
  m('2019-05', 200, 9_000_000),
  m('2019-06', 60, 1_200_000),
  m('2019-07', 0, 0),
  m('2019-08', 150, 7_400_000),
  m('2019-09', 30, 900_000),
];

describe('rendered SVG', () => {
  it('contains no NaN or undefined coordinates', () => {
    for (const metric of ['commits', 'loc'] as const) {
      const svg = render(YEAR, metric);
      expect(svg).not.toMatch(/NaN/);
      expect(svg).not.toMatch(/undefined/);
      expect(svg).not.toMatch(/Infinity/);
    }
  });

  it('keeps every drawn coordinate inside the viewBox', () => {
    for (const metric of ['commits', 'loc'] as const) {
      const svg = render(YEAR, metric);
      for (const [, cx, cy] of svg.matchAll(/cx="([\d.]+)" cy="([\d.]+)"/g)) {
        expect(Number(cx)).toBeGreaterThanOrEqual(0);
        expect(Number(cx)).toBeLessThanOrEqual(720);
        expect(Number(cy)).toBeGreaterThanOrEqual(0);
        expect(Number(cy)).toBeLessThanOrEqual(220);
      }
    }
  });

  it('draws one marker per collected month and none for the gap', () => {
    const svg = render(YEAR, 'commits');
    const circles = [...svg.matchAll(/<circle/g)].length;
    expect(circles).toBe(9);
  });

  it('draws a single unbroken polyline when the gap is only leading', () => {
    const svg = render(YEAR, 'commits');
    expect([...svg.matchAll(/<polyline/g)].length).toBe(1);
  });

  it('splits the polyline when a gap falls mid-axis', () => {
    const holed = YEAR.map((x) =>
      x.month === '2019-04' ? { ...x, collected: false } : x,
    );
    const svg = render(holed, 'commits');
    expect([...svg.matchAll(/<polyline/g)].length).toBe(2);
    expect([...svg.matchAll(/<circle/g)].length).toBe(8);
    expect([...svg.matchAll(/<rect/g)].length).toBe(2);
  });

  it('shades exactly the uncollected band, starting at the left edge', () => {
    const svg = render(YEAR, 'commits');
    const rect = svg.match(/<rect x="([\d.]+)"[^>]*width="([\d.]+)"/);
    expect(rect).not.toBeNull();
    // Plot spans x=46..708 over 12 months => step 55.17. Three uncollected
    // months start at the plot's left edge and cover three bands.
    expect(Number(rect![1])).toBeCloseTo(46, 1);
    expect(Number(rect![2])).toBeCloseTo(3 * ((720 - 46 - 12) / 12), 1);
  });

  it('puts a bigger value higher on the canvas (y is inverted correctly)', () => {
    const svg = render(YEAR, 'commits');
    const pts = [...svg.matchAll(/cy="([\d.]+)"/g)].map((x) => Number(x[1]));
    // 2026-04 (240, the max) is the 4th collected month; 2026-07 (0) is 7th.
    const maxY = pts[3];
    const zeroY = pts[6];
    expect(maxY).toBeLessThan(zeroY);
  });

  it('scales the LOC axis to 5M bands, matching the requested fix', () => {
    const svg = render(YEAR, 'loc');
    // Max collected LOC is 12M -> ticks 0,2M,...,12M (6 bands).
    expect(svg).toContain('>0<');
    expect(svg).toContain('>12M<');
    expect(svg).toContain('>2M<');
  });

  it('anchors the zero gridline at the plot floor for both metrics', () => {
    for (const metric of ['commits', 'loc'] as const) {
      const svg = render(YEAR, metric);
      // First tick line is y=0 -> should sit at PAD.top + plotH = 14 + 176 = 190.
      const firstLine = svg.match(/<line[^>]*y1="([\d.]+)"/);
      expect(Number(firstLine![1])).toBeCloseTo(190, 1);
    }
  });

  it('renders an all-zero collected window without collapsing', () => {
    const flat = YEAR.map((x) => ({ ...x, commits: 0, locChanged: 0 }));
    const svg = render(flat, 'commits');
    expect(svg).not.toMatch(/NaN/);
    expect([...svg.matchAll(/<circle/g)].length).toBe(9);
  });

  it('marks the running month dashed and hollow, not as a solid fall', () => {
    // Regression for the defect found against real data: on the 3rd of the
    // month the last point was 177 commits beside a ~4,000 baseline, drawn
    // solid, and the chart read as a collapse that had not happened.
    const nowMonth = new Date(Date.now() + 5.5 * 3_600_000)
      .toISOString()
      .slice(0, 7);
    const live = YEAR.map((x, i) =>
      i === YEAR.length - 1 ? { ...x, month: nowMonth, commits: 177 } : x,
    );
    const svg = render(live, 'commits');

    expect(svg).toMatch(/stroke-dasharray="4 3"/);
    expect(svg).toContain('fill="rgb(var(--surface))"');
    expect(svg).toContain('(month to date)');
    // Still one marker per collected month — it is marked, not dropped.
    expect([...svg.matchAll(/<circle/g)].length).toBe(9);
  });

  it('leaves a settled axis entirely solid', () => {
    expect(render(YEAR, 'commits')).not.toMatch(/stroke-dasharray/);
    expect(render(YEAR, 'commits')).not.toContain('month to date');
  });

  it('falls back to a message when nothing was collected', () => {
    const none = YEAR.map((x) => ({ ...x, collected: false }));
    const svg = render(none, 'commits');
    expect(svg).toContain('backfill has not reached');
    expect(svg).not.toContain('<svg');
  });
});
