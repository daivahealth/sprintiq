import { describe, expect, it } from 'vitest';
import type { ActiveDeveloper } from '../useInsights';
import {
  DEFAULT_ROSTER_SORT,
  nextRosterSort,
  sortRoster,
} from './roster-sort';

function dev(
  displayName: string,
  commits: number,
  prsOpened: number,
  prsMerged: number,
  locChanged?: number,
): ActiveDeveloper {
  return {
    developer: displayName.toLowerCase(),
    displayName,
    commits,
    prsOpened,
    prsMerged,
    ...(locChanged === undefined ? {} : { locChanged }),
  };
}

const ROSTER = [
  dev('carol', 5, 1, 0, 300),
  dev('Alice', 2, 3, 2, 900),
  dev('bob', 5, 0, 1, 50),
];

const names = (rows: ActiveDeveloper[]) => rows.map((r) => r.displayName);

describe('sortRoster', () => {
  it('defaults to A–Z, case-insensitively', () => {
    expect(names(sortRoster(ROSTER, DEFAULT_ROSTER_SORT))).toEqual([
      'Alice',
      'bob',
      'carol',
    ]);
  });

  it('sorts names Z–A', () => {
    expect(names(sortRoster(ROSTER, { key: 'name', dir: 'desc' }))).toEqual([
      'carol',
      'bob',
      'Alice',
    ]);
  });

  it('sorts commits both ways, breaking ties A–Z', () => {
    expect(names(sortRoster(ROSTER, { key: 'commits', dir: 'desc' }))).toEqual([
      'bob',
      'carol',
      'Alice',
    ]);
    expect(names(sortRoster(ROSTER, { key: 'commits', dir: 'asc' }))).toEqual([
      'Alice',
      'bob',
      'carol',
    ]);
  });

  it('sorts changed LOC, PRs opened and PRs merged', () => {
    expect(names(sortRoster(ROSTER, { key: 'loc', dir: 'desc' }))).toEqual([
      'Alice',
      'carol',
      'bob',
    ]);
    expect(names(sortRoster(ROSTER, { key: 'prsOpened', dir: 'asc' }))).toEqual([
      'bob',
      'carol',
      'Alice',
    ]);
    expect(names(sortRoster(ROSTER, { key: 'prsMerged', dir: 'desc' }))).toEqual([
      'Alice',
      'bob',
      'carol',
    ]);
  });

  it('puts an unknown LOC last in both directions', () => {
    const withUnknown = [...ROSTER, dev('aaron', 1, 0, 0)];
    for (const dir of ['asc', 'desc'] as const) {
      const rows = names(sortRoster(withUnknown, { key: 'loc', dir }));
      expect(rows[rows.length - 1]).toBe('aaron');
    }
  });

  it('does not mutate the input', () => {
    const copy = [...ROSTER];
    sortRoster(ROSTER, { key: 'commits', dir: 'desc' });
    expect(ROSTER).toEqual(copy);
  });
});

describe('nextRosterSort', () => {
  it('flips direction on the same column', () => {
    expect(nextRosterSort(DEFAULT_ROSTER_SORT, 'name')).toEqual({
      key: 'name',
      dir: 'desc',
    });
  });

  it('starts a number column highest-first and names A–Z', () => {
    expect(nextRosterSort(DEFAULT_ROSTER_SORT, 'loc')).toEqual({
      key: 'loc',
      dir: 'desc',
    });
    expect(nextRosterSort({ key: 'loc', dir: 'desc' }, 'name')).toEqual({
      key: 'name',
      dir: 'asc',
    });
  });
});
