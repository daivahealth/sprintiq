import { BadRequestException } from '@nestjs/common';
import { GithubOrg } from '../../collectors/sources/github/github-orgs';
import { assertKnownActiveOrgIn } from './configurations.controller';

function org(organization: string, active: boolean, isDefault = false): GithubOrg {
  return {
    configId: `cfg-${organization}`,
    tenantId: 't1',
    key: isDefault ? 'default' : organization.toLowerCase(),
    isDefault,
    organization,
    active,
    values: { organization },
    secretRefs: {},
    inheritedRefs: [],
  };
}

describe('assertKnownActiveOrgIn', () => {
  const orgs = [org('Acme', true, true), org('Beta', true), org('Gone', false)];

  it('does nothing when no organisation is given', () => {
    expect(() => assertKnownActiveOrgIn(orgs, undefined)).not.toThrow();
  });

  it('accepts a known active organisation', () => {
    expect(() => assertKnownActiveOrgIn(orgs, 'Beta')).not.toThrow();
  });

  it('matches case-insensitively', () => {
    expect(() => assertKnownActiveOrgIn(orgs, 'bETA')).not.toThrow();
  });

  it('rejects an unknown organisation with 400', () => {
    expect(() => assertKnownActiveOrgIn(orgs, 'nope')).toThrow(BadRequestException);
  });

  it('rejects a disabled organisation with 400', () => {
    expect(() => assertKnownActiveOrgIn(orgs, 'Gone')).toThrow(
      'GitHub organisation "Gone" is not configured and active.',
    );
  });
});
