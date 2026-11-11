import type { ActiveDeveloper } from '../useInsights';

/**
 * Column sorting for the Overview's Active developers roster
 * (DASHBOARDS.md §4.4.1).
 *
 * Each sortable column header toggles ascending/descending. The default is
 * alphabetical by name, and every other order is the reader's explicit click,
 * held in component state and never persisted — the condition the 2026-11-11
 * amendment to ADR-0011 attaches to sorting by changed LOC.
 *
 * Role and Copilot are deliberately absent: Role is deferred, and Copilot use
 * is never an order to read people in (ADR-0012).
 */
export type RosterSortKey = 'name' | 'commits' | 'loc' | 'prsOpened' | 'prsMerged';
export type SortDirection = 'asc' | 'desc';
export interface RosterSort {
  key: RosterSortKey;
  dir: SortDirection;
}

export const DEFAULT_ROSTER_SORT: RosterSort = { key: 'name', dir: 'asc' };

/**
 * The next sort after a header click: the same column flips direction, a new
 * column starts A–Z for names and highest-first for numbers.
 */
export function nextRosterSort(current: RosterSort, key: RosterSortKey): RosterSort {
  if (current.key === key) {
    return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  }
  return { key, dir: key === 'name' ? 'asc' : 'desc' };
}

function byName(a: ActiveDeveloper, b: ActiveDeveloper): number {
  return a.displayName.localeCompare(b.displayName, undefined, {
    sensitivity: 'base',
  });
}

function numeric(dev: ActiveDeveloper, key: Exclude<RosterSortKey, 'name'>): number | undefined {
  switch (key) {
    case 'commits':
      return dev.commits;
    case 'loc':
      return dev.locChanged;
    case 'prsOpened':
      return dev.prsOpened;
    case 'prsMerged':
      return dev.prsMerged;
  }
}

/**
 * A sorted copy of the roster. Ties fall back to A–Z by name. A missing value
 * (an API that predates the LOC column renders "—") always goes last in both
 * directions: "we cannot tell" is neither the most nor the least.
 */
export function sortRoster(
  developers: readonly ActiveDeveloper[],
  sort: RosterSort,
): ActiveDeveloper[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const { key } = sort;
  return [...developers].sort((a, b) => {
    if (key === 'name') return sign * byName(a, b);
    const va = numeric(a, key);
    const vb = numeric(b, key);
    if (va === undefined || vb === undefined) {
      if (va === vb) return byName(a, b);
      return va === undefined ? 1 : -1;
    }
    return sign * (va - vb) || byName(a, b);
  });
}
