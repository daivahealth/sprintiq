import { istDateKey, istWeekKey, istWindowFloor } from './time';

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
