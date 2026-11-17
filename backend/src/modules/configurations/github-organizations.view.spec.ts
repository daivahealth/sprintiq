import { toGithubOrgs } from '../../collectors/sources/github/github-orgs';
import { toOrganizationView } from './configurations.controller';

describe('toOrganizationView', () => {
  it('exposes ref names (never values), inheritance, audit status and digest inclusion', () => {
    const [, nh] = toGithubOrgs([
      {
        id: 'd',
        tenantId: 't1',
        key: 'default',
        status: 'active',
        values: { organization: 'athmahealth', syncIntervalMinutes: 15 },
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
      },
      {
        id: 'n',
        tenantId: 't1',
        key: 'nhwebsite',
        status: 'active',
        values: { organization: 'NHWebsite', backfillDays: 30 },
        secretRefs: {},
        createdAt: new Date('2026-11-16'),
      },
    ]);
    const audit = { organization: 'NHWebsite', enabled: false } as never;
    expect(toOrganizationView(nh, audit, 'collecting')).toEqual({
      key: 'nhwebsite',
      organization: 'NHWebsite',
      status: 'active',
      isDefault: false,
      values: {
        organization: 'NHWebsite',
        backfillDays: 30,
        syncIntervalMinutes: 15,
      },
      secretRefs: { tokenRef: 'GITHUB_TOKEN' },
      inheritedRefs: ['tokenRef'],
      inheritedValues: ['syncIntervalMinutes'],
      audit,
      digest: 'collecting',
    });
  });
});
