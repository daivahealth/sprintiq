import {
  WATCHLIST_ACTIVE_WITHIN_WORKING_DAYS,
  WATCHLIST_QUIET_WITHIN_WORKING_DAYS,
  activeDeveloperRoster,
  activeDeveloperSet,
  copilotCell,
  copilotLookup,
  DeveloperActivityService,
  DEVELOPER_ROLES,
  bucketFor,
  commitDays,
  isDeveloperRole,
  monthCollected,
  planningGapDevelopers,
  signalScanRange,
  workingDaysAgo,
} from './developer-activity.service';
import { isMergeCommit } from './merge-commits';

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
      mergeCommits: 0,
      role: null,
      // No Copilot report collected → the column has nothing to say.
      copilot: null,
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

/**
 * The admin-stated DEV/QA/OTH classification, carried onto the roster.
 *
 * SprintIQ cannot observe this — a QA engineer committing test automation and a
 * backend developer look identical in the delivery graph — so it is a human
 * statement, and the one thing the read model must never do is invent one.
 */
describe('activeDeveloperRoster — role', () => {
  const names = new Map([
    ['dev-a', 'Zara Ahmed'],
    ['dev-b', 'Amit Bose'],
  ]);

  it('carries the role an admin set', () => {
    const roster = activeDeveloperRoster(
      new Map([['dev-a', 1]]),
      new Map(),
      new Map(),
      names,
      new Map([['dev-a', 'QA' as const]]),
    );

    expect(roster[0].role).toBe('QA');
  });

  it('reports null for an unclassified developer, never OTH', () => {
    // The distinction the whole feature rests on. `OTH` is a person deciding
    // "none of these"; null is nobody having decided at all. Collapsing them
    // would make an unclassified roster indistinguishable from one somebody
    // had actually been through.
    const roster = activeDeveloperRoster(
      new Map([['dev-a', 1]]),
      new Map(),
      new Map(),
      names,
      new Map(),
    );

    expect(roster[0].role).toBeNull();
  });

  it('does not order by role', () => {
    // Alphabetical stays alphabetical. Grouping the roster by classification
    // would quietly turn it into a comparison between two named groups.
    const roster = activeDeveloperRoster(
      new Map([
        ['dev-a', 1],
        ['dev-b', 1],
      ]),
      new Map(),
      new Map(),
      names,
      new Map([
        ['dev-a', 'DEV' as const],
        ['dev-b', 'QA' as const],
      ]),
    );

    expect(roster.map((r) => r.displayName)).toEqual([
      'Amit Bose',
      'Zara Ahmed',
    ]);
  });
});

/**
 * The closed set. Roles arrive over HTTP, so anything outside it is rejected
 * rather than stored — a stray value would render as an unknown badge that no
 * reader could interpret and no admin could clear.
 */
describe('isDeveloperRole', () => {
  it('accepts exactly DEV, QA and OTH', () => {
    expect(DEVELOPER_ROLES).toEqual(['DEV', 'QA', 'OTH']);
    for (const role of DEVELOPER_ROLES) {
      expect(isDeveloperRole(role)).toBe(true);
    }
  });

  it('rejects anything else, including case variants and the empty string', () => {
    // 'dev' lowercase is the likeliest client mistake and must not slip
    // through into a column the UI matches on exactly.
    for (const bad of ['dev', 'qa', 'Dev', 'DEVELOPER', '', 'OTHER', null]) {
      expect(isDeveloperRole(bad)).toBe(false);
    }
  });
});

describe('activeDeveloperSet', () => {
  const index = {
    byLogin: new Map([['alice_athma', 'alice_athma']]),
    byEmail: new Map([['bob@example.com', 'bob_athma']]),
  };

  it('is the union of commit authors and PR authors', () => {
    // The Overview's "developers with a signal" tile counts both. A set built
    // from committers alone is a different, quietly narrower definition.
    const set = activeDeveloperSet(
      [{ authorLogin: 'alice_athma', authorEmail: null }],
      [{ authorLogin: 'carol_athma' }],
      index,
    );
    expect([...set].sort()).toEqual(['alice_athma', 'carol_athma']);
  });

  it('attributes a commit with no login through its email', () => {
    // GitHub omits author.login unless the commit email is verified on an
    // account, so this is the ordinary case, not an edge case.
    const set = activeDeveloperSet(
      [{ authorLogin: null, authorEmail: 'BOB@example.com' }],
      [],
      index,
    );
    expect([...set]).toEqual(['bob_athma']);
  });

  it('ignores a commit that cannot be attributed to anyone', () => {
    const set = activeDeveloperSet(
      [{ authorLogin: null, authorEmail: 'nobody@example.com' }],
      [],
      index,
    );
    expect(set.size).toBe(0);
  });

  it('ignores a PR with no author login', () => {
    const set = activeDeveloperSet([], [{ authorLogin: null }], index);
    expect(set.size).toBe(0);
  });

  it('attributes a commit login unknown to the index by the raw login', () => {
    // `attributeCommit`'s fallback for a login the resolution pass hasn't
    // reached yet. If this regresses, the person it drops is exactly someone
    // who committed but would be named in a Teams channel as having done
    // nothing — the highest-cost failure this function can have.
    const set = activeDeveloperSet(
      [{ authorLogin: 'dave_unresolved', authorEmail: null }],
      [],
      index,
    );
    expect([...set]).toEqual(['dave_unresolved']);
  });

  it('dedupes a person who is both a commit author and a PR author', () => {
    // The union must be a set of people, not a tally of events. Two records
    // for the same person should never inflate developersWithSignal by one.
    const set = activeDeveloperSet(
      [{ authorLogin: 'alice_athma', authorEmail: null }],
      [{ authorLogin: 'alice_athma' }],
      index,
    );
    expect([...set]).toEqual(['alice_athma']);
  });
});

describe('merge-commit exclusion (METRICS.md §0)', () => {
  const index = {
    byLogin: new Map([
      ['alice', 'alice'],
      ['bob', 'bob'],
    ]),
    byEmail: new Map<string, string>(),
    displayNames: new Map([
      ['alice', 'Alice'],
      ['bob', 'Bob'],
    ]),
  };
  const commit = (
    login: string,
    additions: number,
    parentCount: number | null,
    iso = '2026-10-14T05:00:00Z',
  ) => ({
    authorLogin: login,
    authorEmail: null,
    committedAt: new Date(iso),
    authoredAt: new Date(iso),
    additions,
    deletions: 0,
    parentCount,
  });

  it('leaves merges out of the day total, the LOC and the contributors, and discloses them', () => {
    const [day] = commitDays(
      [
        commit('alice', 300, 1),
        // Bob merged Alice's branch: GitHub reports the same 300 lines again.
        commit('bob', 300, 2),
      ],
      index,
    );
    expect(day.totalCommits).toBe(1);
    expect(day.locChanged).toBe(300);
    expect(day.mergeCommitsExcluded).toBe(1);
    expect(day.developers.map((d) => d.developer)).toEqual(['alice']);
  });

  it('treats an unknown parent count as an ordinary commit', () => {
    const [day] = commitDays([commit('alice', 50, null)], index);
    expect(day.totalCommits).toBe(1);
    expect(day.locChanged).toBe(50);
    expect(day.mergeCommitsExcluded).toBe(0);
  });

  it('keeps a merge-only contributor on the roster with zero commits and their merges disclosed', () => {
    const roster = activeDeveloperRoster(
      new Map([['alice', 1]]),
      new Map([['alice', { additions: 300, deletions: 0 }]]),
      new Map(),
      index.displayNames,
      new Map(),
      new Map([['bob', 1]]),
    );
    const bob = roster.find((r) => r.developer === 'bob');
    expect(bob).toMatchObject({ commits: 0, locChanged: 0, mergeCommits: 1 });
  });

  it('isMergeCommit is true only for two or more parents', () => {
    expect(isMergeCommit({ parentCount: 2 })).toBe(true);
    expect(isMergeCommit({ parentCount: 3 })).toBe(true);
    expect(isMergeCommit({ parentCount: 1 })).toBe(false);
    expect(isMergeCommit({ parentCount: 0 })).toBe(false);
    expect(isMergeCommit({ parentCount: null })).toBe(false);
  });
});

describe('commitDays', () => {
  const index = {
    byLogin: new Map([
      ['alice', 'alice'],
      ['bob', 'bob'],
    ]),
    byEmail: new Map<string, string>(),
    displayNames: new Map([
      ['alice', 'Alice'],
      ['bob', 'Bob'],
    ]),
  };
  const at = (iso: string) => new Date(iso);
  const commit = (
    login: string | null,
    committedAt: string,
    additions: number,
    deletions: number,
  ) => ({
    authorLogin: login,
    authorEmail: null,
    committedAt: at(committedAt),
    authoredAt: at(committedAt),
    additions,
    deletions,
  });

  it('totals changed LOC per IST day alongside the commit count', () => {
    const days = commitDays(
      [
        commit('alice', '2026-10-13T04:00:00Z', 100, 20),
        commit('bob', '2026-10-13T05:00:00Z', 5, 5),
        commit('alice', '2026-10-12T04:00:00Z', 1, 0),
      ],
      index,
    );
    expect(
      days.map((d) => [
        d.date,
        d.totalCommits,
        d.additions,
        d.deletions,
        d.locChanged,
      ]),
    ).toEqual([
      ['2026-10-13', 2, 105, 25, 130],
      ['2026-10-12', 1, 1, 0, 1],
    ]);
  });

  it('buckets by the IST calendar day of the commit time', () => {
    // 2026-10-12T20:00Z is 01:30 IST on the 13th.
    const days = commitDays(
      [commit('alice', '2026-10-12T20:00:00Z', 3, 3)],
      index,
    );
    expect(days[0].date).toBe('2026-10-13');
  });

  it('counts commits that recorded no line changes, so a partial LOC figure is disclosed', () => {
    const days = commitDays(
      [
        commit('alice', '2026-10-13T04:00:00Z', 0, 0),
        commit('bob', '2026-10-13T05:00:00Z', 7, 1),
      ],
      index,
    );
    expect(days[0].commitsWithoutLineChanges).toBe(1);
    expect(days[0].locChanged).toBe(8);
  });

  it('includes unattributed commits in the day LOC total, and still counts them as unattributed', () => {
    const days = commitDays(
      [
        commit(null, '2026-10-13T04:00:00Z', 40, 2),
        commit('bob', '2026-10-13T05:00:00Z', 1, 1),
      ],
      index,
    );
    expect(days[0]).toMatchObject({
      totalCommits: 2,
      unattributedCommits: 1,
      locChanged: 44,
    });
  });

  it('lists contributors alphabetically by commits, never ordered by LOC', () => {
    const days = commitDays(
      [
        commit('bob', '2026-10-13T04:00:00Z', 900, 0),
        commit('alice', '2026-10-13T05:00:00Z', 1, 0),
      ],
      index,
    );
    expect(days[0].developers).toEqual([
      { developer: 'alice', displayName: 'Alice', commits: 1 },
      { developer: 'bob', displayName: 'Bob', commits: 1 },
    ]);
  });

  it('returns days newest first', () => {
    const days = commitDays(
      [
        commit('alice', '2026-10-10T04:00:00Z', 1, 0),
        commit('alice', '2026-10-13T04:00:00Z', 1, 0),
      ],
      index,
    );
    expect(days.map((d) => d.date)).toEqual(['2026-10-13', '2026-10-10']);
  });
});

describe('Copilot column (ADR-0012)', () => {
  const names = new Map([
    ['dev-a', 'Zara Ahmed'],
    ['dev-b', 'Amit Bose'],
    ['dev-c', 'Chitra Das'],
  ]);
  const row = (login: string, day: string, locAdded = 0, interactions = 1) => ({
    login,
    day,
    interactions,
    generations: 0,
    acceptances: 0,
    locAdded,
  });

  it("merges a developer's logins: union of days, sum of lines", () => {
    const lookup = copilotLookup(
      [
        row('asha', '2026-10-10', 100),
        row('Asha-Work', '2026-10-10', 20), // same day, second login
        row('Asha-Work', '2026-10-11', 5),
      ],
      null,
      new Map([
        ['asha', 'dev-a'],
        ['asha-work', 'dev-a'],
      ]),
    );
    expect(copilotCell('dev-a', lookup)).toEqual({
      status: 'active',
      activeDays: 2,
      linesAdded: 125,
    });
  });

  it('counts a day with no activity at all as not active', () => {
    const lookup = copilotLookup(
      [row('asha', '2026-10-10', 0, 0)],
      null,
      new Map([['asha', 'dev-a']]),
    );
    expect(copilotCell('dev-a', lookup).activeDays).toBe(0);
  });

  it('tells "seat, not used" from "no seat", and both from "seats unknown"', () => {
    const byLogin = new Map([
      ['asha', 'dev-a'],
      ['bose', 'dev-b'],
    ]);
    const withSeats = copilotLookup([], ['asha'], byLogin);
    expect(copilotCell('dev-a', withSeats).status).toBe('seat_unused');
    expect(copilotCell('dev-b', withSeats).status).toBe('no_seat');
    const noSeats = copilotLookup([], null, byLogin);
    expect(copilotCell('dev-a', noSeats).status).toBe('no_activity');
  });

  it('never reorders the roster, however much Copilot someone used', () => {
    const roster = activeDeveloperRoster(
      new Map([
        ['dev-a', 1],
        ['dev-b', 1],
        ['dev-c', 1],
      ]),
      new Map(),
      new Map(),
      names,
      new Map(),
      new Map(), // merges
      copilotLookup(
        [row('zara', '2026-10-10', 99_999)],
        null,
        new Map([['zara', 'dev-a']]),
      ),
    );
    expect(roster.map((r) => r.displayName)).toEqual([
      'Amit Bose',
      'Chitra Das',
      'Zara Ahmed',
    ]);
    expect(roster[2].copilot).toEqual({
      status: 'active',
      activeDays: 1,
      linesAdded: 99_999,
    });
    expect(roster[0].copilot?.status).toBe('no_activity');
  });

  it('never adds anyone to the roster: Copilot-only users are not delivery signal', () => {
    const roster = activeDeveloperRoster(
      new Map([['dev-a', 1]]),
      new Map(),
      new Map(),
      names,
      new Map(),
      new Map(), // merges
      copilotLookup(
        [row('bose', '2026-10-10', 10)],
        null,
        new Map([['bose', 'dev-b']]),
      ),
    );
    expect(roster.map((r) => r.developer)).toEqual(['dev-a']);
  });
});

describe('DeveloperActivityService.overview — people and the Copilot column', () => {
  function service(copilotCollected: boolean, tracked: string[] = []) {
    const commit = (login: string) => ({
      sha: `sha-${login}`,
      repoFullName: 'org/repo',
      authorLogin: login,
      authorEmail: null,
      committedAt: new Date('2026-10-10T06:00:00Z'),
      authoredAt: new Date('2026-10-10T06:00:00Z'),
      additions: 1,
      deletions: 0,
    });
    const code = {
      listCommitsPage: jest.fn().mockResolvedValue({
        commits: [
          commit('asha'),
          commit('Copilot'),
          commit('dependabot[bot]'),
          commit('gone'),
          commit('ravi'),
        ],
        truncated: false,
      }),
      copilotUsageRows: jest.fn().mockResolvedValue([
        {
          login: 'asha',
          day: '2026-10-10',
          interactions: 3,
          generations: 0,
          acceptances: 0,
          locAdded: 40,
        },
      ]),
      copilotSeatLogins: jest.fn().mockResolvedValue(['asha']),
      copilotCoverage: jest.fn().mockResolvedValue({
        collected: copilotCollected,
        coveredThrough: copilotCollected ? '2026-10-12' : null,
        reportDaysInWindow: copilotCollected ? 3 : 0,
      }),
    };
    const identities = {
      attributionIndex: jest.fn().mockResolvedValue({
        byLogin: new Map([
          ['asha', 'asha'],
          ['gone', 'gone'],
          ['ravi', 'ravi'],
        ]),
        byEmail: new Map(),
        displayNames: new Map([
          ['asha', 'Asha Rao'],
          ['ravi', 'Ravi Kumar'],
        ]),
        excluded: new Set(['gone']),
      }),
      attributionCoverage: jest.fn().mockResolvedValue({
        commitsInScope: 4,
        commitsUnattributed: 0,
        coveragePct: 100,
        unattributedIdentities: 0,
      }),
      jiraAssigneeIndex: jest.fn().mockResolvedValue({
        byDeveloper: new Map(),
        assignees: { matched: 0 },
      }),
      bridgeCoverage: jest.fn().mockReturnValue({}),
    };
    const prisma = {
      pullRequest: { findMany: jest.fn().mockResolvedValue([]) },
      developerRole: { findMany: jest.fn().mockResolvedValue([]) },
      trackedDeveloper: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            tracked.map((canonicalDeveloperId) => ({ canonicalDeveloperId })),
          ),
      },
    };
    const tenantContext = { requireTenantId: () => 'tenant-a' };
    return new DeveloperActivityService(
      tenantContext as never,
      prisma as never,
      code as never,
      identities as never,
    );
  }

  const from = new Date('2026-10-01T00:00:00+05:30');
  const to = new Date('2026-10-14T23:59:59+05:30');

  it('lists people only, and the tile counts exactly the list', async () => {
    const view = await service(true).overview([], from, to, 14);
    // Copilot (the agent), a [bot] and an admin-excluded account are not people.
    expect(view.activeDevelopers.map((d) => d.developer)).toEqual([
      'asha',
      'ravi',
    ]);
    expect(view.totals.developersWithSignal).toBe(view.activeDevelopers.length);
    // …but their commits still count as work.
    expect(view.totals.commits).toBe(5);
    // Nobody tracked yet: no denominator, nobody set aside.
    expect(view.totals.trackedDevelopers).toBeNull();
    expect(view.notTracked).toEqual([]);
  });

  it('counts tracked developers only once a list exists, and discloses the rest', async () => {
    const view = await service(true, ['asha', 'meera']).overview(
      [],
      from,
      to,
      14,
    );
    // The headline reads "1 of 2 tracked developers"; the roster matches it.
    expect(view.totals.developersWithSignal).toBe(1);
    expect(view.totals.trackedDevelopers).toBe(2);
    expect(view.activeDevelopers.map((d) => d.developer)).toEqual(['asha']);
    // Ravi was active but is not tracked: named beside the tile, not dropped.
    // Bots and excluded accounts are still not people, tracked or not.
    expect(view.notTracked).toEqual([
      { developer: 'ravi', displayName: 'Ravi Kumar' },
    ]);
    // Work volume is never scoped: every commit still counts.
    expect(view.totals.commits).toBe(5);
  });

  it('attaches the Copilot cell and the freshness when reports were collected', async () => {
    const view = await service(true).overview([], from, to, 14);
    expect(view.activeDevelopers[0].copilot).toEqual({
      status: 'active',
      activeDays: 1,
      linesAdded: 40,
    });
    expect(view.copilot).toEqual({
      collected: true,
      coveredThrough: '2026-10-12',
      reportDaysInWindow: 3,
    });
  });

  it('leaves the cell null when no report was ever collected', async () => {
    const view = await service(false).overview([], from, to, 14);
    expect(view.activeDevelopers[0].copilot).toBeNull();
    expect(view.copilot.collected).toBe(false);
  });
});
