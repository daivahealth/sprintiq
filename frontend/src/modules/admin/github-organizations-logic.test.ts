import { describe, expect, it } from 'vitest';
import { inheritedPlaceholder, orgPayload, validateOrgLogin } from './github-organizations-logic';

describe('validateOrgLogin', () => {
  it('accepts a GitHub login not yet configured', () => {
    expect(validateOrgLogin('NHWebsite', ['athmahealth'])).toBeNull();
  });
  it('rejects invalid logins and duplicates (case-insensitive)', () => {
    expect(validateOrgLogin('not a login', [])).toMatch(/GitHub login/);
    expect(validateOrgLogin('', [])).toMatch(/GitHub login/);
    expect(validateOrgLogin('AthmaHealth', ['athmahealth'])).toMatch(/already configured/);
  });
});

describe('orgPayload', () => {
  it('keys the row by the lowercased login and drops blank refs (they inherit)', () => {
    expect(
      orgPayload({
        organization: 'NHWebsite',
        tokenRef: 'GITHUB_TOKEN_NHWEBSITE',
        auditLogTokenRef: '',
        copilotMetricsTokenRef: '',
        backfillDays: '30',
        syncIntervalMinutes: '',
        enabled: true,
      }),
    ).toEqual({
      namespace: 'github',
      key: 'nhwebsite',
      values: { organization: 'NHWebsite', backfillDays: 30 },
      secretRefs: { tokenRef: 'GITHUB_TOKEN_NHWEBSITE' },
      status: 'active',
    });
  });
});

describe('inheritedPlaceholder', () => {
  it("names the default organisation's ref", () => {
    const def = { organization: 'athmahealth', secretRefs: { tokenRef: 'GITHUB_TOKEN' } } as never;
    expect(inheritedPlaceholder('tokenRef', def)).toBe('blank = GITHUB_TOKEN from athmahealth');
    expect(inheritedPlaceholder('copilotMetricsTokenRef', def)).toBe('blank = not set');
  });
});
