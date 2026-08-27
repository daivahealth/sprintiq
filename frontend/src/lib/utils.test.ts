import { describe, expect, it } from 'vitest';
import {
  istDayAxis,
  istDayKeyOffset,
  istDaySpan,
  istDayStart,
  istTodayKey,
  istWindowFloor,
} from './utils';

/**
 * These mirror `backend/src/common/time.ts`. They are tested separately, on
 * both sides, because a mirror that has drifted looks exactly like a mirror
 * that has not — until a board and its API disagree about which day a commit
 * belongs to.
 */
describe('IST calendar-date helpers', () => {
  it('starts an IST day at 18:30Z the previous day', () => {
    expect(istDayStart('2026-04-01').toISOString()).toBe(
      '2026-03-31T18:30:00.000Z',
    );
  });

  it('counts a span inclusively, matching the backend', () => {
    expect(istDaySpan('2026-04-01', '2026-06-30')).toBe(91);
    expect(istDaySpan('2026-08-25', '2026-08-25')).toBe(1);
  });

  it('offsets a date key by whole days, across a month boundary', () => {
    expect(istDayKeyOffset('2026-08-25', -6)).toBe('2026-08-19');
    expect(istDayKeyOffset('2026-07-01', -1)).toBe('2026-06-30');
    expect(istDayKeyOffset('2026-06-30', 1)).toBe('2026-07-01');
  });

  it('agrees with the preset floor: the 7-day window starts 6 days back', () => {
    // Derived from today on both sides, so this pins the agreement rather than
    // a calendar date that stops being true tomorrow.
    const today = istTodayKey();
    const startKey = istDayKeyOffset(today, -6);

    expect(istDaySpan(startKey, today)).toBe(7);
    expect(istDayStart(startKey).getTime()).toBe(istWindowFloor(7).getTime());
  });
});

describe('istDayAxis', () => {
  it('ends on the given day rather than always on today', () => {
    // The bug this prevents: a chart for a closed past range drew an axis
    // ending today, so every April commit fell outside it and the whole
    // window rendered as zeros.
    const axis = istDayAxis(3, '2026-06-30');
    expect(axis).toEqual(['2026-06-28', '2026-06-29', '2026-06-30']);
  });

  it('spans a month boundary correctly', () => {
    expect(istDayAxis(2, '2026-07-01')).toEqual(['2026-06-30', '2026-07-01']);
  });

  it('returns windowDays entries, oldest first', () => {
    const axis = istDayAxis(7, '2026-08-25');
    expect(axis).toHaveLength(7);
    expect(axis[0]).toBe('2026-08-19');
    expect(axis[6]).toBe('2026-08-25');
  });
});
