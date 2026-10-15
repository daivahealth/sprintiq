import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CommitChart } from './CommitChart';

type Point = { date: string; commits: number; locChanged: number };

function render(series: Point[], metric: 'loc' | 'commits') {
  return renderToStaticMarkup(
    createElement(CommitChart, {
      series,
      windowDays: 3,
      endKey: '2026-10-13',
      metric,
    }),
  );
}

/** Bar heights in document order (one rect per day, oldest first). */
function barHeights(svg: string): number[] {
  return [...svg.matchAll(/<rect[^>]*height="([\d.]+)"/g)].map((m) =>
    Number(m[1]),
  );
}

// Day 1: many commits, few lines. Day 3: one commit, a large diff.
const SERIES: Point[] = [
  { date: '2026-10-11', commits: 9, locChanged: 40 },
  { date: '2026-10-13', commits: 1, locChanged: 4_000 },
];

describe('CommitChart', () => {
  it('in LOC mode, scales bars by changed lines rather than commit count', () => {
    const svg = render(SERIES, 'loc');
    const [day1, day2, day3] = barHeights(svg);
    expect(day3).toBeGreaterThan(day1);
    expect(day2).toBe(0);
    expect(svg).toContain('aria-label="Changed lines of code per day"');
    expect(svg).toContain('4k');
  });

  it('in commits mode, scales bars by commit count', () => {
    const svg = render(SERIES, 'commits');
    const [day1, , day3] = barHeights(svg);
    expect(day1).toBeGreaterThan(day3);
    expect(svg).toContain('aria-label="Commits per day"');
  });

  it('draws no relative-scale overlay in either mode', () => {
    for (const metric of ['loc', 'commits'] as const) {
      const svg = render(SERIES, metric);
      expect(svg).not.toContain('<polyline');
      expect(svg).not.toMatch(/relative scale/i);
    }
  });

  it('puts both quantities in each bar tooltip', () => {
    const svg = render(SERIES, 'loc');
    expect(svg).toMatch(/2026-10-13 · 4,000 lines changed · 1 commit</);
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
