import { describe, expect, it } from 'vitest';
import {
  draftOf,
  inheritedPlaceholder,
  inheritedValuePlaceholder,
  orgPayload,
  rereadMessage,
  validateOrgLogin,
  withoutOrgOnlyFields,
} from './github-organizations-logic';

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
        branchHistoryLookbackDays: '',
        maxHistoryBranches: '',
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

const draft = (over: Record<string, unknown> = {}) =>
  ({
    organization: 'NHWebsite',
    tokenRef: '',
    auditLogTokenRef: '',
    copilotMetricsTokenRef: '',
    backfillDays: '',
    syncIntervalMinutes: '',
    branchHistoryLookbackDays: '',
    maxHistoryBranches: '',
    enabled: true,
    ...over,
  }) as never;

describe('orgPayload branch-history settings', () => {
  it('includes them when set and omits them when blank', () => {
    expect(
      orgPayload(draft({ branchHistoryLookbackDays: '60', maxHistoryBranches: '250' })).values,
    ).toEqual({ organization: 'NHWebsite', branchHistoryLookbackDays: 60, maxHistoryBranches: 250 });
    expect(orgPayload(draft()).values).toEqual({ organization: 'NHWebsite' });
  });
  it('keeps 0 for max branches (history off) but drops a non-positive lookback', () => {
    expect(orgPayload(draft({ maxHistoryBranches: '0', branchHistoryLookbackDays: '0' })).values).toEqual({
      organization: 'NHWebsite',
      maxHistoryBranches: 0,
    });
  });
});

describe('draftOf', () => {
  const org = {
    organization: 'NHWebsite',
    status: 'active',
    secretRefs: {},
    inheritedRefs: [],
    inheritedValues: ['backfillDays'],
    values: { organization: 'NHWebsite', backfillDays: 400, branchHistoryLookbackDays: 60, maxHistoryBranches: 0 },
  } as never;
  it('round-trips the history settings and leaves an inherited window blank', () => {
    const d = draftOf(org);
    expect(d.branchHistoryLookbackDays).toBe('60');
    expect(d.maxHistoryBranches).toBe('0');
    expect(d.backfillDays).toBe('');
    expect(orgPayload(d).values).toEqual({
      organization: 'NHWebsite',
      branchHistoryLookbackDays: 60,
      maxHistoryBranches: 0,
    });
  });
});

describe('inheritedValuePlaceholder', () => {
  it("names the default organisation's value", () => {
    const def = { organization: 'athmahealth', values: { backfillDays: 400 } } as never;
    expect(inheritedValuePlaceholder('backfillDays', def, '90')).toBe('blank = 400 from athmahealth');
    expect(inheritedValuePlaceholder('syncIntervalMinutes', def, '240')).toBe('blank = 240');
    expect(inheritedValuePlaceholder('backfillDays', undefined, '90')).toBe('blank = 90');
  });
});

describe('rereadMessage', () => {
  it('words each outcome', () => {
    expect(rereadMessage({ status: 'scheduled', repos: ['a/b', 'a/c'] })).toBe(
      'Branch history will be read for 2 repos at the next full branch sweep (runs hourly).',
    );
    expect(rereadMessage({ status: 'scheduled', repos: ['a/b'] })).toMatch(/for 1 repo at/);
    expect(rereadMessage({ status: 'scheduled', repos: ['a/b'], readOnNextPushOnly: true })).toBe(
      'Branch history will be read for 1 repo when each repository is next pushed to (full sweep is off).',
    );
    expect(rereadMessage({ status: 'scheduled', repos: [] })).toBe(
      'No repositories registered for this organisation yet — run Sync org first.',
    );
    expect(rereadMessage({ status: 'not_seeded', repos: [] })).toBe('Not seeded yet — wait for the first sweep.');
    expect(rereadMessage({ status: 'not_ingest', repos: [] })).toBe('Audit route is not in ingest mode.');
  });
});

describe('withoutOrgOnlyFields', () => {
  it('hides the two history settings from the github section only', () => {
    const f = (key: string) => ({ key, label: key, kind: 'number' });
    const out = withoutOrgOnlyFields({
      sections: [
        { namespace: 'github', fields: [f('backfillDays'), f('branchHistoryLookbackDays'), f('maxHistoryBranches')] },
        { namespace: 'jira', fields: [f('backfillDays')] },
      ],
    } as never);
    expect(out.sections[0].fields.map((x) => x.key)).toEqual(['backfillDays']);
    expect(out.sections[1].fields).toHaveLength(1);
  });
});
