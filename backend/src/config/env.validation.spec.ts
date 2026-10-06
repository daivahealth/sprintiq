// class-validator's decorators (@IsOptional, @IsEnum, the custom
// IsTriStateFlag, ...) rely on reflect-metadata, which only `main.ts`
// imports at the app's real entry point. No other spec file in this repo
// calls `validateEnv` directly, so this is the first place that needs it
// loaded explicitly for Jest.
import 'reflect-metadata';
import { validateEnv } from './env.validation';

describe('validateEnv — DIGEST_CRON_ENABLED', () => {
  const base = {
    DATABASE_URL: 'postgresql://sprintiq:sprintiq@localhost:5432/sprintiq',
    JWT_SECRET: 'test-secret',
  };

  it('passes when DIGEST_CRON_ENABLED is unset — the no-change path', () => {
    expect(() => validateEnv({ ...base })).not.toThrow();
  });

  it('passes when DIGEST_CRON_ENABLED is present but empty (an "X=" line in an env file) — parseTriStateFlag treats it the same as unset', () => {
    expect(() =>
      validateEnv({ ...base, DIGEST_CRON_ENABLED: '' }),
    ).not.toThrow();
  });

  it.each(['true', '1', 'on', 'false', '0', 'off', 'True', 'OFF'])(
    'passes for accepted spelling %s',
    (value) => {
      expect(() =>
        validateEnv({ ...base, DIGEST_CRON_ENABLED: value }),
      ).not.toThrow();
    },
  );

  it('fails boot on a typo rather than silently arming the cron', () => {
    // The exact failure mode called out in the design: a typo like "flase"
    // must not be silently treated as unset (armed) at boot.
    expect(() =>
      validateEnv({ ...base, DIGEST_CRON_ENABLED: 'flase' }),
    ).toThrow(/DIGEST_CRON_ENABLED/);
  });

  it('fails boot on an unrecognised value like "yes"', () => {
    expect(() => validateEnv({ ...base, DIGEST_CRON_ENABLED: 'yes' })).toThrow(
      /DIGEST_CRON_ENABLED/,
    );
  });
});

describe('GitHub audit sync env', () => {
  const base = { DATABASE_URL: 'postgres://x', JWT_SECRET: 's' };
  it('fails boot on an invalid audit interval', () => {
    expect(() =>
      validateEnv({ ...base, GITHUB_AUDIT_SYNC_INTERVAL_MINUTES: '7' }),
    ).toThrow(/GITHUB_AUDIT_SYNC_INTERVAL_MINUTES/);
  });
  it('fails boot on an invalid audit mode', () => {
    expect(() =>
      validateEnv({ ...base, GITHUB_AUDIT_SYNC_MODE: 'yes' }),
    ).toThrow(/GITHUB_AUDIT_SYNC_MODE/);
  });
  it('accepts valid audit settings', () => {
    expect(() =>
      validateEnv({
        ...base,
        GITHUB_AUDIT_SYNC_MODE: 'shadow',
        GITHUB_AUDIT_SYNC_INTERVAL_MINUTES: '15',
      }),
    ).not.toThrow();
  });
});
