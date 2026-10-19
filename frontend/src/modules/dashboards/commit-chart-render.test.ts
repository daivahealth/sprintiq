import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CommitChart } from './CommitChart';

type Point = { date: string; commits: number; locChanged: number };

function render(
  series: Point[],
  metric: 'loc' | 'commits',
  extra: Partial<Parameters<typeof CommitChart>[0]> = {},
) {
  return renderToStaticMarkup(
    createElement(CommitChart, {
      series,
      windowDays: 3,
      endKey: '2026-10-13',
      metric,
      ...extra,
    }),
  );
}

/**
 * Height of each day's point above the baseline, oldest first, read off the
 * line's own coordinates — SVG y grows downward, so a larger value is a
 * smaller y.
 */
function pointHeights(svg: string): number[] {
  const points = svg.match(/<polyline[^>]*points="([^"]+)"/)?.[1] ?? '';
  const ys = points.split(' ').map((p) => Number(p.split(',')[1]));
  const base = Math.max(...ys);
  return ys.map((y) => base - y);
}

// Day 1: many commits, few lines. Day 3: one commit, a large diff.
const SERIES: Point[] = [
  { date: '2026-10-11', commits: 9, locChanged: 40 },
  { date: '2026-10-13', commits: 1, locChanged: 4_000 },
];

describe('CommitChart', () => {
  it('draws one line with a point per day of the window, empty days included', () => {
    const svg = render(SERIES, 'loc');
    expect(svg.match(/<polyline/g)).toHaveLength(1);
    expect(pointHeights(svg)).toHaveLength(3);
    // A day with no commits sits ON the zero line — measured, not missing.
    expect(pointHeights(svg)[1]).toBe(0);
    expect(svg).not.toMatch(/<rect[^>]*class="fill-chart-1"/);
  });

  it('in LOC mode, scales the line by changed lines rather than commit count', () => {
    const svg = render(SERIES, 'loc');
    const [day1, , day3] = pointHeights(svg);
    expect(day3).toBeGreaterThan(day1);
    expect(svg).toContain('aria-label="Changed lines of code per day"');
    expect(svg).toContain('4k');
    expect(svg).toContain('stroke-chart-2');
  });

  it('in commits mode, scales the line by commit count', () => {
    const svg = render(SERIES, 'commits');
    const [day1, , day3] = pointHeights(svg);
    expect(day1).toBeGreaterThan(day3);
    expect(svg).toContain('aria-label="Commits per day"');
    expect(svg).toContain('stroke-chart-1');
  });

  it('draws no relative-scale overlay in either mode', () => {
    for (const metric of ['loc', 'commits'] as const) {
      const svg = render(SERIES, metric);
      expect(svg.match(/<polyline/g)).toHaveLength(1);
      expect(svg).not.toMatch(/relative scale/i);
    }
  });

  it('puts both quantities in each day tooltip', () => {
    const svg = render(SERIES, 'loc');
    expect(svg).toMatch(/2026-10-13 · 4,000 lines changed · 1 commit</);
  });

  it('marks each day on a short window, and drops the markers on a long one', () => {
    expect(render(SERIES, 'loc').match(/<circle/g)).toHaveLength(3);
    const year = render(SERIES, 'loc', { windowDays: 365 });
    expect(year).not.toContain('<circle');
    expect(year).toContain('<polyline');
  });

  it('is read-only by default: no day is a button', () => {
    expect(render(SERIES, 'loc')).not.toContain('role="button"');
  });

  it('makes every day a keyboard-reachable button when days are selectable', () => {
    const svg = render(SERIES, 'loc', {
      onSelectDay: () => {},
      selectedDate: '2026-10-13',
    });
    expect(svg.match(/role="button"/g)).toHaveLength(3);
    expect(svg.match(/tabindex="0"/g)).toHaveLength(3);
    expect(svg).toMatch(/data-day="2026-10-13"[^>]*aria-pressed="true"/);
    expect(svg).toMatch(/data-day="2026-10-11"[^>]*aria-pressed="false"/);
    expect(svg).toContain('click to see who committed');
  });

  it('keeps the opened day visible even when markers are dropped', () => {
    const svg = render(SERIES, 'loc', {
      windowDays: 365,
      onSelectDay: () => {},
      selectedDate: '2026-10-13',
    });
    expect(svg.match(/<circle/g)).toHaveLength(1);
  });

  it('says so when commits exist but recorded no line changes, instead of drawing an empty LOC chart', () => {
    const svg = render([{ date: '2026-10-13', commits: 3, locChanged: 0 }], 'loc');
    expect(svg).toContain('recorded no line changes');
    expect(svg).not.toContain('<svg');
  });

  it('keeps the no-commits empty state', () => {
    expect(render([], 'loc')).toContain('No commits in this window.');
  });

  it('never renders NaN, undefined or Infinity', () => {
    for (const metric of ['loc', 'commits'] as const) {
      const svg = render(SERIES, metric);
      expect(svg).not.toMatch(/NaN|undefined|Infinity/);
    }
  });
});
