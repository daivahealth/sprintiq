import {
  orgOfRepo,
  pickGithubOrg,
  repoInOrg,
  repoInOrgWhere,
  toGithubOrgs,
  type GithubOrgConfigRow,
} from './github-orgs';

const row = (o: Record<string, unknown>): GithubOrgConfigRow => ({
  id: `cfg-${String(o.key)}`,
  tenantId: 't1',
  status: 'active',
  values: {},
  secretRefs: {},
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...o,
} as GithubOrgConfigRow);

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
      row({ key: 'zeta', values: { organization: 'Zeta' }, createdAt: new Date('2026-03-01') }),
      row({ key: 'nhwebsite', values: { organization: 'NHWebsite' }, createdAt: new Date('2026-02-01') }),
      row({ key: 'default', values: { organization: 'athmahealth' }, createdAt: new Date('2026-05-01') }),
    ]);
    expect(orgs.map((o) => o.organization)).toEqual(['athmahealth', 'NHWebsite', 'Zeta']);
    expect(orgs[0].isDefault).toBe(true);
  });

  it('inherits blank token refs from the default row, and says which', () => {
    const [def, nh] = toGithubOrgs([
      row({
        key: 'default',
        values: { organization: 'athmahealth' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN', auditLogTokenRef: 'GITHUB_AUDIT_TOKEN' },
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
      row({ key: 'default', values: { organization: 'athmahealth' }, secretRefs: { tokenRef: 'A' } }),
      row({ tenantId: 't2', key: 'other', values: { organization: 'Other' } }),
      row({ tenantId: 't2', key: 'bad', values: { organization: 'not a login' } }),
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
      row({ key: 'default', status: 'disabled', values: { organization: 'athmahealth' } }),
    ]);
    expect(o.active).toBe(false);
  });
});
