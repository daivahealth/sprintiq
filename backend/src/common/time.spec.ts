import {
  istDateKey,
  istDayEnd,
  istDaySpan,
  istDayStart,
  istMonthEnd,
  istMonthKey,
  istMonthStart,
  istWeekKey,
  istWindowFloor,
  lastIstMonths,
} from './time';

/**
 * These four helpers are now the app's single definition of "when" — every
 * board's window and every bucket key routes through them. Before that, the
 * Scope Bar used a rolling UTC window, the activity boards used IST calendar
 * days, and Productivity bucketed weeks on UTC Sundays, so "last 7 days"
 * denoted three different ranges depending on which screen you read.
 */
describe('IST time helpers', () => {
  it('files a late-evening UTC moment under the following IST day', () => {
    // 19:00Z is 00:30 IST the next morning — the boundary that made a UTC
    // bucket and an IST bucket disagree about which day work happened on.
    expect(istDateKey(new Date('2026-08-13T19:00:00.000Z'))).toBe('2026-08-14');
    expect(istDateKey(new Date('2026-08-13T18:00:00.000Z'))).toBe('2026-08-13');
  });

  it('floors a window to IST midnight, inclusive of today', () => {
    const now = new Date('2026-08-14T09:00:00.000Z');

    // A 1-day window is "since IST midnight today", not a rolling 24h lookback.
    expect(istWindowFloor(1, now).toISOString()).toBe(
      '2026-08-13T18:30:00.000Z',
    );
    // 7 days covers today plus the six before it.
    expect(istWindowFloor(7, now).toISOString()).toBe(
      '2026-08-07T18:30:00.000Z',
    );
  });

  it('buckets weeks on the IST Sunday', () => {
    // 2026-08-14 is a Friday; its week starts Sunday 2026-08-09.
    expect(istWeekKey(new Date('2026-08-14T09:00:00.000Z'))).toBe('2026-08-09');

    // Sunday 00:30 IST = Saturday 19:00Z. On UTC this fell in the PREVIOUS
    // week; on IST it correctly starts the new one.
    expect(istWeekKey(new Date('2026-08-08T19:00:00.000Z'))).toBe('2026-08-09');
  });

  it('agrees with itself: a window floor is the start of its own IST day', () => {
    const now = new Date('2026-08-14T09:00:00.000Z');
    expect(istDateKey(istWindowFloor(1, now))).toBe(istDateKey(now));
  });
});

/**
 * The custom-range half of the same definition: a user-picked range arrives as
 * two IST calendar-date keys and must resolve to the same instants a preset
 * would. If these drift from `istWindowFloor`, a hand-picked week and the
 * "7 days" preset return different numbers for the same seven days.
 */
describe('IST calendar-date range helpers', () => {
  it('starts a day at IST midnight, which is 18:30Z the day before', () => {
    expect(istDayStart('2026-04-01').toISOString()).toBe(
      '2026-03-31T18:30:00.000Z',
    );
  });

  it('ends a day at its last instant, not at the next midnight', () => {
    // Inclusive: a commit at 23:59 IST on the To date is inside the range.
    expect(istDayEnd('2026-06-30').toISOString()).toBe(
      '2026-06-30T18:29:59.999Z',
    );
  });

  it('counts a span inclusively at both ends', () => {
    // Apr 30 + May 31 + Jun 30.
    expect(istDaySpan('2026-04-01', '2026-06-30')).toBe(91);
    // A single day is one day, not zero.
    expect(istDaySpan('2026-08-25', '2026-08-25')).toBe(1);
    expect(istDaySpan('2026-08-19', '2026-08-25')).toBe(7);
  });

  it('agrees with the preset floor: 7 hand-picked days === the 7-day window', () => {
    const now = new Date('2026-08-25T09:00:00.000Z');
    const todayKey = istDateKey(now);
    const startKey = istDateKey(istWindowFloor(7, now));

    expect(istDayStart(startKey).toISOString()).toBe(
      istWindowFloor(7, now).toISOString(),
    );
    expect(istDaySpan(startKey, todayKey)).toBe(7);
  });
});

/**
 * The month-bucket half, added for the Overview's 12-month trend. Same rule as
 * the day and week helpers: a bucket boundary is IST midnight, so a commit made
 * late on the last evening of a month in India is not filed under the next one.
 */
describe('IST calendar-month helpers', () => {
  it('files a late-evening UTC moment under the following IST month', () => {
    // 2026-08-31T19:00Z is 00:30 IST on 1 September — the boundary a UTC
    // bucket gets wrong, moving a commit into the previous month.
    expect(istMonthKey(new Date('2026-08-31T19:00:00.000Z'))).toBe('2026-09');
    expect(istMonthKey(new Date('2026-08-31T18:00:00.000Z'))).toBe('2026-08');
  });

  it('starts a month at IST midnight on the first, which is 18:30Z the day before', () => {
    expect(istMonthStart('2026-09').toISOString()).toBe(
      '2026-08-31T18:30:00.000Z',
    );
  });

  it('ends a month at its last instant, not at the next month’s midnight', () => {
    // Inclusive, for the same reason istDayEnd is: an aggregate bounded at the
    // next midnight would count the first half-hour of the following month.
    expect(istMonthEnd('2026-09').toISOString()).toBe(
      '2026-09-30T18:29:59.999Z',
    );
  });

  it('ends a December at the following January, not month 13', () => {
    // The rollover a naive `month + 1` gets wrong.
    expect(istMonthEnd('2026-12').toISOString()).toBe(
      '2026-12-31T18:29:59.999Z',
    );
  });

  it('handles February in a leap year', () => {
    expect(istMonthEnd('2028-02').toISOString()).toBe(
      '2028-02-29T18:29:59.999Z',
    );
  });

  it('lists the last N IST months oldest-first, ending with the current one', () => {
    // Oldest-first because a chart plots left-to-right in time; the day series
    // is newest-first for a list, and mixing the two orders is how a trend
    // gets drawn backwards.
    const months = lastIstMonths(12, new Date('2026-09-03T09:00:00.000Z'));

    expect(months).toHaveLength(12);
    expect(months[0]).toBe('2025-10');
    expect(months[11]).toBe('2026-09');
  });

  it('walks back across a year boundary without producing a month 0', () => {
    const months = lastIstMonths(3, new Date('2026-01-15T09:00:00.000Z'));
    expect(months).toEqual(['2025-11', '2025-12', '2026-01']);
  });

  it('takes the current month from IST, not UTC', () => {
    // 30 Sep 19:00Z is already 1 October in India, so the window ends on the
    // October bucket. On UTC this window would be a month short at the top.
    const months = lastIstMonths(2, new Date('2026-09-30T19:00:00.000Z'));
    expect(months).toEqual(['2026-09', '2026-10']);
  });

  it('agrees with itself: a month start is filed under its own month', () => {
    expect(istMonthKey(istMonthStart('2026-09'))).toBe('2026-09');
    expect(istMonthKey(istMonthEnd('2026-09'))).toBe('2026-09');
  });
});
