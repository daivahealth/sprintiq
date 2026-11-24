import { describe, expect, it } from 'vitest';
import type { EffortsView } from '../useInsights';
import { effortsDisclosures, formatLogged } from './efforts-format';

describe('formatLogged', () => {
  it('formats hours and minutes', () => {
    expect(formatLogged(0)).toBe('0');
    expect(formatLogged(20)).toBe('<1m');
    expect(formatLogged(45 * 60)).toBe('45m');
    expect(formatLogged(8 * 3600)).toBe('8h');
    expect(formatLogged(2.5 * 3600)).toBe('2h 30m');
  });
});

function view(overrides: Partial<EffortsView> = {}): EffortsView {
  return {
    days: [],
    rows: [],
    sprintFrom: null,
    sprintTo: null,
    rule: 'r',
    roster: { tracked: 0, shown: 0, unresolved: 0, suppressed: 0, notShown: 0 },
    disclosures: {
      itemsInScope: 0,
      itemsWithoutWorklogSnapshot: 0,
      unattributedWorklogs: 0,
    },
    computedAt: '',
    ...overrides,
  };
}

describe('effortsDisclosures', () => {
  it('says nothing when nothing applies', () => {
    expect(effortsDisclosures(view())).toEqual([]);
  });

  it('states each reason a figure could understate', () => {
    const lines = effortsDisclosures(
      view({
        roster: { tracked: 14, shown: 10, unresolved: 1, suppressed: 1, notShown: 2 },
        disclosures: {
          itemsInScope: 40,
          itemsWithoutWorklogSnapshot: 6,
          unattributedWorklogs: 3,
        },
      }),
    );
    expect(lines).toEqual([
      'Showing the first 10 of 12 tracked developers, A–Z.',
      '1 tracked entry could not be matched to a known developer and is not shown.',
      '1 tracked entry is excluded (bots, admin exclusions or Watchlist exclusions).',
      'Worklogs not yet collected for 6 of 40 sprint items — hours may be understated until the backfill catches up.',
      '3 worklogs in this range could not be matched to a developer.',
    ]);
  });
});
