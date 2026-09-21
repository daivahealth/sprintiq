import { isValidTriStateFlagValue, parseTriStateFlag } from './env-flags';

describe('parseTriStateFlag', () => {
  it('returns undefined when unset — the no-change path an upgrade must preserve', () => {
    expect(parseTriStateFlag('DIGEST_CRON_ENABLED', undefined)).toBeUndefined();
  });

  it('returns undefined for an empty string — treated the same as unset, not as false', () => {
    expect(parseTriStateFlag('DIGEST_CRON_ENABLED', '')).toBeUndefined();
    expect(parseTriStateFlag('DIGEST_CRON_ENABLED', '   ')).toBeUndefined();
  });

  it.each(['true', '1', 'on'])('parses truthy spelling %s to true', (value) => {
    expect(parseTriStateFlag('DIGEST_CRON_ENABLED', value)).toBe(true);
  });

  it.each(['false', '0', 'off'])(
    'parses falsey spelling %s to false',
    (value) => {
      expect(parseTriStateFlag('DIGEST_CRON_ENABLED', value)).toBe(false);
    },
  );

  it('is case-insensitive on both truthy and falsey spellings', () => {
    expect(parseTriStateFlag('DIGEST_CRON_ENABLED', 'True')).toBe(true);
    expect(parseTriStateFlag('DIGEST_CRON_ENABLED', 'ON')).toBe(true);
    expect(parseTriStateFlag('DIGEST_CRON_ENABLED', 'False')).toBe(false);
    expect(parseTriStateFlag('DIGEST_CRON_ENABLED', 'OFF')).toBe(false);
  });

  it('treats the string "false" as false, never as truthy — the exact Boolean(process.env.X) coercion bug this guards against', () => {
    // Boolean('false') === true in plain JS; this parser must not do that.
    expect(parseTriStateFlag('DIGEST_CRON_ENABLED', 'false')).toBe(false);
    expect(Boolean('false')).toBe(true); // documents the bug being guarded against
  });

  it('throws on an unrecognised value rather than guessing — a typo must fail loudly, not silently arm or disarm the cron', () => {
    expect(() => parseTriStateFlag('DIGEST_CRON_ENABLED', 'flase')).toThrow(
      /Invalid DIGEST_CRON_ENABLED "flase"/,
    );
    expect(() => parseTriStateFlag('DIGEST_CRON_ENABLED', 'yes')).toThrow();
    expect(() => parseTriStateFlag('DIGEST_CRON_ENABLED', '2')).toThrow();
  });
});

describe('isValidTriStateFlagValue', () => {
  it('accepts every spelling parseTriStateFlag accepts', () => {
    for (const value of [
      'true',
      '1',
      'on',
      'false',
      '0',
      'off',
      'True',
      'OFF',
    ]) {
      expect(isValidTriStateFlagValue(value)).toBe(true);
    }
  });

  it('rejects an unrecognised value — the same value env.validation.ts must fail boot on', () => {
    expect(isValidTriStateFlagValue('flase')).toBe(false);
    expect(isValidTriStateFlagValue('yes')).toBe(false);
    expect(isValidTriStateFlagValue('')).toBe(false);
  });
});
