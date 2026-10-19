import { describe, expect, it } from 'vitest';
import {
  developerDayHref,
  formatReportedDay,
  previousDayHeadline,
  withheldExplanation,
  type PreviousDayView,
} from './previous-day';

const base: PreviousDayView = {
  day: '2026-10-16',
  outcome: 'named',
  withheld: null,
  ruleText: "Counts commits and PRs opened only — reviews and Jira aren't counted.",
  rosterCount: 66,
  flagged: Array.from({ length: 15 }, (_, i) => ({
    developer: `d${i}`,
    displayName: `D${i}`,
  })),
  unresolved: [],
  incomplete: [],
  unattributedCommits: 0,
  lastDigestRun: null,
  namedThenNowActive: [],
};

describe('previous-day view text', () => {
  it('names the day as a reader would', () => {
    expect(formatReportedDay('2026-10-16')).toBe('Fri 16 Oct');
  });

  it('summarises a named day with the roster size', () => {
    expect(previousDayHeadline(base)).toBe(
      '15 of 66 tracked developers showed no delivery signal on Fri 16 Oct',
    );
  });

  it('summarises the all-clear and the withheld day', () => {
    expect(
      previousDayHeadline({ ...base, outcome: 'all_clear', flagged: [] }),
    ).toMatch(/^Every evaluable tracked developer/);
    expect(
      previousDayHeadline({ ...base, outcome: 'withheld', flagged: [] }),
    ).toMatch(/^Names withheld for Fri 16 Oct/);
  });

  it('explains a withheld outcome in words, keeping the detail', () => {
    expect(withheldExplanation(null)).toBeNull();
    expect(
      withheldExplanation({
        outcome: 'withheld_stale_data',
        detail: 'audit log read only through 10:00',
      }),
    ).toBe(
      'collection is behind or failing, so a missing commit may simply not have arrived (audit log read only through 10:00)',
    );
    expect(
      withheldExplanation({ outcome: 'something_new', detail: 'x' }),
    ).toBe('the data cannot vouch for the day (x)');
  });

  it('links to the developer page scoped to that one day', () => {
    expect(developerDayHref('Arun-Balaji-M_athma', '2026-10-16')).toBe(
      '../developer?developer=Arun-Balaji-M_athma&window=custom&from=2026-10-16&to=2026-10-16',
    );
  });
});
