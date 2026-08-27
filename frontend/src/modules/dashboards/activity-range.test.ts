import { describe, expect, it } from 'vitest';
import { istTodayKey } from '../../lib/utils';
import {
  DEFAULT_RANGE,
  formatDateKey,
  isValidCustom,
  parseRange,
  presetDateKeys,
  rangeDays,
  rangeEndKey,
  rangeEndsInPast,
  rangeLabel,
  rangeParams,
  rangeTo,
} from './activity-range';

const CUSTOM = { kind: 'custom', from: '2026-04-01', to: '2026-06-30' } as const;
const WEEK = { kind: 'preset', window: 'week' } as const;

describe('rangeParams', () => {
  it('sends a preset exactly as the boards always have', () => {
    expect(rangeParams(WEEK).toString()).toBe('window=week');
  });

  it('sends a custom range as window=custom plus both dates', () => {
    expect(rangeParams(CUSTOM).toString()).toBe(
      'window=custom&from=2026-04-01&to=2026-06-30',
    );
  });
});

describe('parseRange', () => {
  it('round-trips a custom range through the URL', () => {
    expect(parseRange(rangeParams(CUSTOM))).toEqual(CUSTOM);
  });

  it('round-trips a preset', () => {
    expect(parseRange(rangeParams(WEEK))).toEqual(WEEK);
  });

  it('falls back to the default rather than rendering nothing', () => {
    // A hand-edited or truncated URL must not blank the section.
    expect(parseRange(new URLSearchParams('window=custom'))).toEqual(
      DEFAULT_RANGE,
    );
    expect(
      parseRange(new URLSearchParams('window=custom&from=nope&to=2026-06-30')),
    ).toEqual(DEFAULT_RANGE);
    expect(
      parseRange(
        new URLSearchParams('window=custom&from=2026-06-30&to=2026-04-01'),
      ),
    ).toEqual(DEFAULT_RANGE);
    expect(parseRange(new URLSearchParams('window=fortnight'))).toEqual(
      DEFAULT_RANGE,
    );
    expect(parseRange(new URLSearchParams())).toEqual(DEFAULT_RANGE);
  });
});

describe('rangeDays', () => {
  it('counts a custom range inclusively, like the backend', () => {
    expect(rangeDays(CUSTOM)).toBe(91);
    expect(
      rangeDays({ kind: 'custom', from: '2026-06-30', to: '2026-06-30' }),
    ).toBe(1);
  });

  it('reads a preset from the shared window map', () => {
    expect(rangeDays(WEEK)).toBe(7);
  });
});

describe('presetDateKeys', () => {
  it('seeds the custom fields with the preset you were already reading', () => {
    const seeded = presetDateKeys('week');
    expect(seeded.to).toBe(istTodayKey());
    expect(rangeDays({ kind: 'custom', ...seeded })).toBe(7);
  });
});

describe('isValidCustom', () => {
  it('accepts a well-formed past range', () => {
    expect(isValidCustom('2026-04-01', '2026-06-30')).toBe(true);
  });

  it('rejects a backwards range, a malformed date, and a future end', () => {
    expect(isValidCustom('2026-06-30', '2026-04-01')).toBe(false);
    expect(isValidCustom('01/04/2026', '2026-06-30')).toBe(false);
    expect(isValidCustom('2026-13-45', '2026-06-30')).toBe(false);
    expect(isValidCustom('2026-04-01', '2099-01-01')).toBe(false);
  });

  it('accepts a range ending today', () => {
    expect(isValidCustom(istTodayKey(), istTodayKey())).toBe(true);
  });
});

describe('labels and ends', () => {
  it('formats a date key without depending on the machine locale', () => {
    // Built from a fixed month table rather than toLocaleDateString: a label
    // that reads differently on the CI box than in the browser is a label
    // nobody can pin in a test.
    expect(formatDateKey('2026-04-01')).toBe('1 Apr 2026');
    expect(formatDateKey('2026-12-25')).toBe('25 Dec 2026');
  });

  it('names a custom range by its interval and a preset by its word', () => {
    expect(rangeLabel(CUSTOM)).toBe('1 Apr 2026 – 30 Jun 2026');
    expect(rangeLabel(WEEK)).toBe('7 days');
  });

  it('ends a custom range on its To day and a preset on today', () => {
    expect(rangeEndKey(CUSTOM)).toBe('2026-06-30');
    expect(rangeEndKey(WEEK)).toBe(istTodayKey());
  });

  it('reports a past-ending range, which presets never are', () => {
    expect(rangeEndsInPast(CUSTOM)).toBe(true);
    expect(rangeEndsInPast(WEEK)).toBe(false);
    expect(
      rangeEndsInPast({ kind: 'custom', from: '2026-01-01', to: istTodayKey() }),
    ).toBe(false);
  });

  it('gives a custom range an end instant, and a preset none', () => {
    expect(rangeTo(CUSTOM)).toBe('2026-06-30T18:29:59.999Z');
    expect(rangeTo(WEEK)).toBeUndefined();
  });
});
