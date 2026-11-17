import { BadRequestException } from '@nestjs/common';
import { GithubOrg } from '../../collectors/sources/github/github-orgs';
import {
  assertKnownActiveOrgIn,
  ConfigurationsController,
} from './configurations.controller';

function org(
  organization: string,
  active: boolean,
  isDefault = false,
): GithubOrg {
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
    inheritedValues: [],
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
    expect(() => assertKnownActiveOrgIn(orgs, 'nope')).toThrow(
      BadRequestException,
    );
  });

  it('rejects a disabled organisation with 400', () => {
    expect(() => assertKnownActiveOrgIn(orgs, 'Gone')).toThrow(
      'GitHub organisation "Gone" is not configured and active.',
    );
  });
});

describe('rereadBranchHistory with an organisation', () => {
  function build(registered: string[]) {
    const prisma = {
      tenantConfiguration: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'd',
            tenantId: 't1',
            key: 'default',
            status: 'active',
            values: { organization: 'athmahealth' },
            secretRefs: {},
          },
          {
            id: 'n',
            tenantId: 't1',
            key: 'nhwebsite',
            status: 'active',
            values: { organization: 'NHWebsite' },
            secretRefs: {},
          },
        ]),
      },
    };
    const auditSync = {
      rereadBranchHistory: jest.fn().mockResolvedValue({
        status: 'scheduled',
        repos: registered,
        unknown: [],
        readOnNextPushOnly: false,
      }),
    };
    const controller = new ConfigurationsController(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      auditSync as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { controller, auditSync };
  }
  const user = { tenantId: 't1', userId: 'u1' } as never;

  it('passes the organisation through, leaving repos to the service', async () => {
    const { controller, auditSync } = build(['NHWebsite/site']);
    await controller.rereadBranchHistory(user, { organization: 'nhwebsite' });
    expect(auditSync.rereadBranchHistory).toHaveBeenCalledWith(
      't1',
      undefined,
      undefined,
      'nhwebsite',
    );
  });

  it('rejects an unknown organisation with 400 before touching anything', async () => {
    const { controller, auditSync } = build([]);
    await expect(
      controller.rereadBranchHistory(user, { organization: 'nope' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(auditSync.rereadBranchHistory).not.toHaveBeenCalled();
  });

  it('with no organisation, behaves as before (all repos)', async () => {
    const { controller, auditSync } = build(['a/b']);
    await controller.rereadBranchHistory(user, {});
    expect(auditSync.rereadBranchHistory).toHaveBeenCalledWith(
      't1',
      undefined,
      undefined,
      undefined,
    );
  });
});
