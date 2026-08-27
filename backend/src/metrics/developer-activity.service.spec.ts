import {
  WATCHLIST_ACTIVE_WITHIN_WORKING_DAYS,
  WATCHLIST_QUIET_WITHIN_WORKING_DAYS,
  bucketFor,
  planningGapDevelopers,
  signalScanRange,
  workingDaysAgo,
} from './developer-activity.service';

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
