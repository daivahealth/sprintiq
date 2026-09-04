import {
  WATCHLIST_ACTIVE_WITHIN_WORKING_DAYS,
  WATCHLIST_QUIET_WITHIN_WORKING_DAYS,
  activeDeveloperRoster,
  bucketFor,
  monthCollected,
  planningGapDevelopers,
  signalScanRange,
  workingDaysAgo,
} from './developer-activity.service';

describe('activeDeveloperRoster', () => {
  const names = new Map([
    ['dev-a', 'Zara Ahmed'],
    ['dev-b', 'Amit Bose'],
  ]);

  it('is the union of commit authors and PR authors, not just committers', () => {
    // The roster exists to explain the "Developers with a signal" tile, and
    // that tile counts anyone with a commit OR a PR. A roster built from
    // committers alone would be shorter than the number printed above it —
    // two figures on one screen disagreeing about the same window.
    const roster = activeDeveloperRoster(
      new Map([['dev-a', 3]]),
      new Map(),
      new Map([['dev-b', { opened: 2, merged: 1 }]]),
      names,
    );

    expect(roster.map((r) => r.developer).sort()).toEqual(['dev-a', 'dev-b']);
  });

  it('orders alphabetically by display name, never by volume', () => {
    // CLAUDE.md: no volume ranking. Sorting by commits is the reader's
    // explicit act in the UI (§4.1.3), never what the API hands over.
    const roster = activeDeveloperRoster(
      new Map([
        ['dev-a', 99],
        ['dev-b', 1],
      ]),
      new Map(),
      new Map(),
      names,
    );

    expect(roster.map((r) => r.displayName)).toEqual([
      'Amit Bose',
      'Zara Ahmed',
    ]);
  });

  it('counts PRs opened and merged separately', () => {
    const roster = activeDeveloperRoster(
      new Map([['dev-b', 4]]),
      new Map(),
      new Map([['dev-b', { opened: 5, merged: 2 }]]),
      names,
    );

    expect(roster[0]).toEqual({
      developer: 'dev-b',
      displayName: 'Amit Bose',
      commits: 4,
      additions: 0,
      deletions: 0,
      locChanged: 0,
      prsOpened: 5,
      prsMerged: 2,
    });
  });

  it('reports zero rather than omitting a signal the person does not have', () => {
    // A reviewer-only or PR-only contributor still belongs on the roster. An
    // absent key would render as a blank cell and read as missing data.
    const roster = activeDeveloperRoster(
      new Map(),
      new Map(),
      new Map([['dev-a', { opened: 1, merged: 0 }]]),
      names,
    );

    expect(roster[0].commits).toBe(0);
    expect(roster[0].prsMerged).toBe(0);
  });

  it('falls back to the canonical id when no display name resolved', () => {
    // Same rule as the day drill-down: never render an empty name cell.
    const roster = activeDeveloperRoster(
      new Map([['dev-unknown', 1]]),
      new Map(),
      new Map(),
      names,
    );

    expect(roster[0].displayName).toBe('dev-unknown');
  });
});

describe('workingDaysAgo', () => {
  it('skips weekends, so a Friday commit is not stale by Monday', () => {
    // The whole reason the thresholds are in working days: on calendar days a
    // "7 day" rule spends two of them on a weekend nobody was expected to
    // commit through, and the roster reads quieter every Monday morning.
    const monday = new Date('2026-08-24T10:00:00Z');
    expect(monday.getDay()).toBe(1);

    // One working day back from Monday is the previous Friday, not Sunday.
    expect(workingDaysAgo(monday, 1).getDay()).toBe(5);
  });

  it('counts back the requested number of weekdays', () => {
    const friday = new Date('2026-08-21T10:00:00Z');
    const back = workingDaysAgo(friday, 5);
    // Five working days before a Friday is the previous Friday.
    expect(back.getDay()).toBe(5);
    expect(Math.round((friday.getTime() - back.getTime()) / 86_400_000)).toBe(
      7,
    );
  });
});

describe('bucketFor', () => {
  const now = new Date('2026-08-25T10:00:00Z');

  it('calls a developer with no signal at all no_signal, not quiet', () => {
    expect(bucketFor(null, now)).toBe('no_signal');
  });

  it('treats a signal inside the active threshold as active', () => {
    const yesterday = new Date(now.getTime() - 86_400_000);
    expect(bucketFor(yesterday, now)).toBe('active');
  });

  it('separates quiet from no_signal at the wider threshold', () => {
    // ~3 working weeks back: past active, still inside the quiet window.
    const threeWeeks = workingDaysAgo(now, 15);
    expect(bucketFor(threeWeeks, now)).toBe('quiet');

    // Well past the quiet window.
    const longAgo = workingDaysAgo(now, 60);
    expect(bucketFor(longAgo, now)).toBe('no_signal');
  });

  it('puts a signal exactly on the active boundary in the active bucket', () => {
    // Boundary belongs to the kinder bucket. Being one hour over a threshold
    // is not evidence about a person, and this page names people.
    const boundary = workingDaysAgo(now, WATCHLIST_ACTIVE_WITHIN_WORKING_DAYS);
    expect(bucketFor(boundary, now)).toBe('active');
  });
});

describe('planningGapDevelopers', () => {
  it('excludes a committer the assignee bridge never matched', () => {
    // The regression this function exists for. Overview once filtered on
    // bridge membership, so an unmatched developer — whose tickets we simply
    // cannot see — was counted as having nothing assigned. On a tenant with
    // 41% assignee coverage that accuses most of the roster of working
    // off-plan on the strength of our own data gap.
    const gap = planningGapDevelopers(
      ['matched-with-work', 'matched-no-work', 'never-matched'],
      new Set(['matched-with-work', 'matched-no-work']),
      new Map([['matched-with-work', 3]]),
    );

    expect(gap).toEqual(['matched-no-work']);
  });

  it('reports a matched developer carrying no open item', () => {
    const gap = planningGapDevelopers(
      ['dev'],
      new Set(['dev']),
      new Map([['dev', 0]]),
    );
    expect(gap).toEqual(['dev']);
  });

  it('is empty when the bridge matched nobody, rather than naming everyone', () => {
    const gap = planningGapDevelopers(['a', 'b', 'c'], new Set(), new Map());
    expect(gap).toEqual([]);
  });

  it('does not invent a gap for someone who never committed', () => {
    const gap = planningGapDevelopers([], new Set(['idle']), new Map());
    expect(gap).toEqual([]);
  });
});

describe('signalScanRange', () => {
  it('scans back one quiet-threshold from the reference moment', () => {
    const asOf = new Date('2026-08-25T10:00:00Z');
    const range = signalScanRange(asOf);

    expect(range.gte.toISOString()).toBe(
      workingDaysAgo(asOf, WATCHLIST_QUIET_WITHIN_WORKING_DAYS).toISOString(),
    );
  });

  it('bounds the scan ABOVE at the reference moment', () => {
    // The half that makes a historical range honest. Without an upper bound,
    // someone who went quiet in May and came back in August reads as "active"
    // on an April–June view — a signal from outside the range deciding a
    // bucket inside it.
    const asOf = new Date('2026-06-30T18:29:59.999Z');
    const range = signalScanRange(asOf);
    const august = new Date('2026-08-10T05:00:00.000Z');

    expect(range.lte).toEqual(asOf);
    expect(august > range.lte).toBe(true);
  });

  it('buckets against the range end, so a June view answers for June', () => {
    const asOf = new Date('2026-06-30T18:29:59.999Z');
    const juneCommit = new Date('2026-06-29T10:00:00.000Z');

    // Active as of 30 June — which is the question an April–June board asks.
    expect(bucketFor(juneCommit, asOf)).toBe('active');
    // The same commit, judged from today, is ancient. Both are true; the page
    // must pick one moment and say which.
    expect(bucketFor(juneCommit, new Date('2026-08-25T10:00:00Z'))).toBe(
      'no_signal',
    );
  });
});

/**
 * Whether a month on the 12-month trend rests on data we actually collected.
 *
 * The distinction the chart is built around: a month with no commits collected
 * and a month with no commits are opposite findings, and plotting the first as
 * a zero asserts the second. Same null-is-not-zero rule the Overview's
 * "Committing, nothing assigned" tile already follows.
 */
describe('monthCollected', () => {
  it('accepts a month starting on or after the collection floor', () => {
    const floor = new Date('2026-03-01T00:00:00.000Z');
    expect(monthCollected('2026-04', floor)).toBe(true);
    expect(monthCollected('2026-09', floor)).toBe(true);
  });

  it('rejects a month that ended before collection ever reached it', () => {
    const floor = new Date('2026-03-01T00:00:00.000Z');
    expect(monthCollected('2026-01', floor)).toBe(false);
  });

  it('rejects the month the floor falls inside, because it is only part-walked', () => {
    // The backfill reached 14 March, so March's first fortnight is missing.
    // Counting it would under-report a month the chart presents as whole —
    // conservative here means the caption explains one absent bar, not that a
    // half-collected March reads as a real dip.
    const floor = new Date('2026-03-14T09:00:00.000Z');
    expect(monthCollected('2026-03', floor)).toBe(false);
    expect(monthCollected('2026-04', floor)).toBe(true);
  });

  it('accepts a month starting exactly at the floor', () => {
    // IST midnight on 1 March, which is 18:30Z on 28 February.
    const floor = new Date('2026-02-28T18:30:00.000Z');
    expect(monthCollected('2026-03', floor)).toBe(true);
  });

  it('treats an unknown floor as collected rather than blanking the chart', () => {
    // `collectedBackTo` is null when any active connection has walked nowhere,
    // which means "we do not know how deep history goes" — not "there is no
    // history". Dimming all twelve months would report a certainty we lack in
    // the opposite direction; the null travels in the payload instead, and the
    // caption says the depth is unknown.
    expect(monthCollected('2020-01', null)).toBe(true);
  });
});

/**
 * Changed LOC per person on the Overview roster.
 *
 * Volume, never a score — CLAUDE.md is explicit that LOC is not a productivity
 * measure, so this ships with no sort-by-LOC control and no ordering by it.
 * It is the same figure the Developer page already shows for one person,
 * carried onto the roster so the window can be read without opening four pages.
 */
describe('activeDeveloperRoster — changed LOC', () => {
  const names = new Map([
    ['dev-a', 'Zara Ahmed'],
    ['dev-b', 'Amit Bose'],
  ]);

  it('sums additions and deletions per person, and totals them as changed LOC', () => {
    const roster = activeDeveloperRoster(
      new Map([['dev-a', 2]]),
      new Map([['dev-a', { additions: 120, deletions: 45 }]]),
      new Map(),
      names,
    );

    expect(roster[0].additions).toBe(120);
    expect(roster[0].deletions).toBe(45);
    // Changed LOC is the SUM, matching every other board. A net of 75 would
    // report a refactor that removed as much as it added as almost no work.
    expect(roster[0].locChanged).toBe(165);
  });

  it('reports zero for someone with PRs but no commits, rather than omitting it', () => {
    // Same rule the commit count follows: an absent key renders as a blank
    // cell and reads as missing data, which is a different claim from none.
    const roster = activeDeveloperRoster(
      new Map(),
      new Map(),
      new Map([['dev-a', { opened: 1, merged: 0 }]]),
      names,
    );

    expect(roster[0].locChanged).toBe(0);
    expect(roster[0].additions).toBe(0);
  });

  it('still orders alphabetically, never by volume of code changed', () => {
    // The rule that matters most here. LOC is the most misread number on the
    // page, and an ordering by it would make the roster a leaderboard by
    // default — which is what CLAUDE.md forbids.
    const roster = activeDeveloperRoster(
      new Map([
        ['dev-a', 1],
        ['dev-b', 1],
      ]),
      new Map([
        ['dev-a', { additions: 99_999, deletions: 0 }],
        ['dev-b', { additions: 1, deletions: 0 }],
      ]),
      new Map(),
      names,
    );

    expect(roster.map((r) => r.displayName)).toEqual([
      'Amit Bose',
      'Zara Ahmed',
    ]);
  });
});
