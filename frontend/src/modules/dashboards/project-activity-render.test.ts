import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { istDayAxis } from '../../lib/utils';
import { ProjectActivityChart } from './ProjectActivityChart';
import type { ProjectActivityRow } from './useInsights';

const today = istDayAxis(1)[0];

function row(
  projectKey: string,
  commits: number,
  locChanged: number,
): ProjectActivityRow {
  return {
    projectKey,
    commits,
    locChanged,
    additions: locChanged,
    deletions: 0,
    activeRepos: 1,
    topRepo: null,
    contributors: 1,
    dailySeries: [{ date: today, commits, locChanged }],
  } as ProjectActivityRow;
}

function render(rows: ProjectActivityRow[]) {
  return renderToStaticMarkup(
    createElement(ProjectActivityChart, { rows, windowDays: 7 }),
  );
}

describe('ProjectActivityChart', () => {
  it('plots changed lines of code per project', () => {
    const svg = render([row('BIG', 1, 5_000), row('BUSY', 20, 50)]);
    expect(svg).toContain(
      'aria-label="Changed lines of code per day by project"',
    );
    expect(svg).toMatch(/BIG · [\d-]+ · 5,000 lines changed · 1 commit</);
  });

  it('chooses and orders the plotted projects by changed LOC, not commits', () => {
    const rows = [
      row('C1', 50, 10),
      row('C2', 40, 10),
      row('C3', 30, 10),
      row('C4', 20, 10),
      row('C5', 10, 10),
      row('C6', 5, 10),
      row('HUGE', 1, 9_000),
    ];
    const svg = render(rows);
    // The legend lists plotted projects in order; HUGE must lead and make the cut.
    const legend = [...svg.matchAll(/<\/span>([A-Z0-9]+)<\/span>/g)].map(
      (m) => m[1],
    );
    expect(legend[0]).toBe('HUGE');
    expect(legend).toHaveLength(6);
    expect(legend).not.toContain('C6');
  });

  it('says so when commits exist but recorded no line changes', () => {
    const svg = render([row('ZERO', 4, 0)]);
    expect(svg).toContain('recorded no line changes');
  });

  it('never renders NaN, undefined or Infinity', () => {
    const svg = render([row('A', 3, 1_234), row('B', 1, 0)]);
    expect(svg).not.toMatch(/NaN|undefined|Infinity/);
  });
});
