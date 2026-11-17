import {
  branchHistorySettings,
  orgOfRepo,
  pickGithubOrg,
  repoInOrg,
  repoInOrgWhere,
  toGithubOrgs,
  type GithubOrgConfigRow,
} from './github-orgs';

const row = (o: Record<string, unknown>): GithubOrgConfigRow =>
  ({
    id: `cfg-${String(o.key)}`,
    tenantId: 't1',
    status: 'active',
    values: {},
    secretRefs: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...o,
  }) as GithubOrgConfigRow;

describe('github-orgs', () => {
  it('derives the lowercased org of a repo full name', () => {
    expect(orgOfRepo('NHWebsite/site')).toBe('nhwebsite');
    expect(orgOfRepo('athmahealth/ehr')).toBe('athmahealth');
    expect(repoInOrg('NHWebsite/site', 'nhwebsite')).toBe(true);
    expect(repoInOrg('athmahealth/ehr', 'NHWebsite')).toBe(false);
    expect(repoInOrgWhere('NHWebsite')).toEqual({
      startsWith: 'NHWebsite/',
      mode: 'insensitive',
    });
  });

  it('puts the default row first, then others by creation time', () => {
    const orgs = toGithubOrgs([
      row({
        key: 'zeta',
        values: { organization: 'Zeta' },
        createdAt: new Date('2026-03-01'),
      }),
      row({
        key: 'nhwebsite',
        values: { organization: 'NHWebsite' },
        createdAt: new Date('2026-02-01'),
      }),
      row({
        key: 'default',
        values: { organization: 'athmahealth' },
        createdAt: new Date('2026-05-01'),
      }),
    ]);
    expect(orgs.map((o) => o.organization)).toEqual([
      'athmahealth',
      'NHWebsite',
      'Zeta',
    ]);
    expect(orgs[0].isDefault).toBe(true);
  });

  it('inherits blank token refs from the default row, and says which', () => {
    const [def, nh] = toGithubOrgs([
      row({
        key: 'default',
        values: { organization: 'athmahealth' },
        secretRefs: {
          tokenRef: 'GITHUB_TOKEN',
          auditLogTokenRef: 'GITHUB_AUDIT_TOKEN',
        },
      }),
      row({
        key: 'nhwebsite',
        values: { organization: 'NHWebsite' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN_NHWEBSITE' },
        createdAt: new Date('2026-11-16'),
      }),
    ]);
    expect(def.inheritedRefs).toEqual([]);
    expect(nh.secretRefs).toEqual({
      tokenRef: 'GITHUB_TOKEN_NHWEBSITE',
      auditLogTokenRef: 'GITHUB_AUDIT_TOKEN',
    });
    expect(nh.inheritedRefs).toEqual(['auditLogTokenRef']);
  });

  it('never inherits across tenants and drops rows without a valid login', () => {
    const orgs = toGithubOrgs([
      row({
        key: 'default',
        values: { organization: 'athmahealth' },
        secretRefs: { tokenRef: 'A' },
      }),
      row({ tenantId: 't2', key: 'other', values: { organization: 'Other' } }),
      row({
        tenantId: 't2',
        key: 'bad',
        values: { organization: 'not a login' },
      }),
    ]);
    const other = orgs.find((o) => o.tenantId === 't2');
    expect(other?.secretRefs).toEqual({});
    expect(orgs).toHaveLength(2);
  });

  it('picks the default org when none is named, else matches case-insensitively', () => {
    const orgs = toGithubOrgs([
      row({ key: 'default', values: { organization: 'athmahealth' } }),
      row({ key: 'nhwebsite', values: { organization: 'NHWebsite' } }),
    ]);
    expect(pickGithubOrg(orgs)?.organization).toBe('athmahealth');
    expect(pickGithubOrg(orgs, 'nhwebsite')?.organization).toBe('NHWebsite');
    expect(pickGithubOrg(orgs, 'nope')).toBeUndefined();
  });

  it('marks disabled rows inactive', () => {
    const [o] = toGithubOrgs([
      row({
        key: 'default',
        status: 'disabled',
        values: { organization: 'athmahealth' },
      }),
    ]);
    expect(o.active).toBe(false);
  });
});

describe('branchHistorySettings', () => {
  const cfg = { newBranchLookbackDays: 30, newRepoMaxBranches: 50 };
  const orgsOf = (extra: Record<string, unknown>, key = 'nhwebsite') =>
    toGithubOrgs([
      row({ key: 'default', values: { organization: 'athmahealth' } }),
      row({ key, values: { organization: 'NHWebsite', ...extra } }),
    ]);

  it('the default org falls back to the env-derived config', () => {
    const [def] = orgsOf({});
    expect(branchHistorySettings(def, cfg)).toEqual({
      lookbackDays: 30,
      maxBranches: 50,
    });
  });

  it('an additional org falls back to the env lookback and 200 branches', () => {
    const [, nh] = orgsOf({});
    expect(branchHistorySettings(nh, cfg)).toEqual({
      lookbackDays: 30,
      maxBranches: 200,
    });
  });

  it('explicit values win, including 0 branches', () => {
    const [, nh] = orgsOf({
      branchHistoryLookbackDays: 60,
      maxHistoryBranches: 0,
    });
    expect(branchHistorySettings(nh, cfg)).toEqual({
      lookbackDays: 60,
      maxBranches: 0,
    });
    const [def] = toGithubOrgs([
      row({
        key: 'default',
        values: {
          organization: 'athmahealth',
          branchHistoryLookbackDays: 7,
          maxHistoryBranches: 120,
        },
      }),
    ]);
    expect(branchHistorySettings(def, cfg)).toEqual({
      lookbackDays: 7,
      maxBranches: 120,
    });
  });

  it('ignores invalid values', () => {
    const [, nh] = orgsOf({
      branchHistoryLookbackDays: 'abc',
      maxHistoryBranches: -3,
    });
    expect(branchHistorySettings(nh, cfg)).toEqual({
      lookbackDays: 30,
      maxBranches: 200,
    });
    const [, nh2] = orgsOf({
      branchHistoryLookbackDays: 1.5,
      maxHistoryBranches: NaN,
    });
    expect(branchHistorySettings(nh2, cfg)).toEqual({
      lookbackDays: 30,
      maxBranches: 200,
    });
  });
});

describe('window inheritance for added organisations', () => {
  const def = row({
    key: 'default',
    values: {
      organization: 'athmahealth',
      backfillDays: 400,
      syncIntervalMinutes: 15,
      defaultRepo: 'athmahealth/x',
      apiBaseUrl: 'https://ghe.example/api',
      branchHistoryLookbackDays: 45,
      maxHistoryBranches: 99,
    },
  });
  const added = (values: Record<string, unknown> = {}) =>
    row({ key: 'nhwebsite', values: { organization: 'NHWebsite', ...values } });

  it('blank backfillDays / syncIntervalMinutes inherit the default row, and say which', () => {
    const [, nh] = toGithubOrgs([def, added()]);
    expect(nh.values.backfillDays).toBe(400);
    expect(nh.values.syncIntervalMinutes).toBe(15);
    expect(nh.inheritedValues).toEqual(['backfillDays', 'syncIntervalMinutes']);
  });

  it('never inherits organization, defaultRepo, apiBaseUrl or the history settings', () => {
    const [, nh] = toGithubOrgs([def, added()]);
    expect(nh.organization).toBe('NHWebsite');
    expect(nh.values.defaultRepo).toBeUndefined();
    expect(nh.values.apiBaseUrl).toBeUndefined();
    expect(nh.values.branchHistoryLookbackDays).toBeUndefined();
    expect(nh.values.maxHistoryBranches).toBeUndefined();
  });

  it('an explicit value wins and is not marked inherited', () => {
    const [, nh] = toGithubOrgs([def, added({ backfillDays: 30 })]);
    expect(nh.values.backfillDays).toBe(30);
    expect(nh.inheritedValues).toEqual(['syncIntervalMinutes']);
  });

  it('the default row inherits nothing', () => {
    expect(toGithubOrgs([def])[0].inheritedValues).toEqual([]);
  });

  it('never inherits across tenants', () => {
    const orgs = toGithubOrgs([
      def,
      row({ tenantId: 't2', key: 'other', values: { organization: 'Other' } }),
    ]);
    const other = orgs.find((o) => o.tenantId === 't2');
    expect(other?.values.backfillDays).toBeUndefined();
    expect(other?.inheritedValues).toEqual([]);
  });
});
