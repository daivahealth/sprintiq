import { toGithubOrgs } from '../sources/github/github-orgs';
import { GithubOrgSyncSchedulerService } from './github-org-sync-scheduler.service';

const cfgRow = (
  o: Record<string, unknown>,
): Record<string, unknown> & Parameters<typeof toGithubOrgs>[0][number] =>
  ({
    id: `cfg-${String(o.tenantId)}-${String(o.key ?? 'default')}`,
    key: 'default',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...o,
  }) as never;

function setup(
  rows: Record<string, unknown>[],
  env: Record<string, string> = {},
) {
  const prev = { ...process.env };
  Object.assign(process.env, env);
  const prisma = {
    tenantConfiguration: { findMany: jest.fn().mockResolvedValue(rows) },
  };
  const secrets = {
    resolve: jest.fn(async (_t: string, ref: string) =>
      ref === 'MISSING' ? '' : `tok:${ref}`,
    ),
  };
  const orgSync = {
    syncOrgRepos: jest.fn().mockResolvedValue({
      reposFound: 3,
      created: 1,
      updated: 2,
      skipped: 0,
      rateLimited: false,
    }),
  };
  const tenantContext = {
    runWithTenant: jest.fn((_t: string, fn: () => unknown) => fn()),
  };
  const config = { get: jest.fn() };
  const svc = new GithubOrgSyncSchedulerService(
    prisma as never,
    secrets as never,
    orgSync as never,
    tenantContext as never,
    config as never,
  );
  const restore = () => {
    process.env = prev;
  };
  return { svc, prisma, secrets, orgSync, tenantContext, restore };
}

const tenant = (
  tenantId: string,
  values: Record<string, unknown>,
  secretRefs: Record<string, unknown>,
) => cfgRow({ tenantId, values, secretRefs });

describe('GithubOrgSyncSchedulerService', () => {
  it('syncs every configured tenant with the same arguments as the admin button', async () => {
    const t = setup([
      tenant(
        't1',
        { organization: 'acme', backfillDays: 30 },
        { tokenRef: 'GH' },
      ),
      tenant('t2', { organization: 'beta' }, { tokenRef: 'GH2' }),
    ]);
    try {
      await t.svc.tick();
      expect(t.orgSync.syncOrgRepos).toHaveBeenCalledWith(
        't1',
        'acme',
        'GH',
        'tok:GH',
        30,
      );
      // No backfillDays configured: the admin endpoint's default of 90.
      expect(t.orgSync.syncOrgRepos).toHaveBeenCalledWith(
        't2',
        'beta',
        'GH2',
        'tok:GH2',
        90,
      );
      expect(t.tenantContext.runWithTenant).toHaveBeenCalledTimes(2);
    } finally {
      t.restore();
    }
  });

  it('skips a tenant with no organization, no token ref, or no stored token', async () => {
    const t = setup([
      tenant('t1', {}, { tokenRef: 'GH' }),
      tenant('t2', { organization: 'acme' }, {}),
      tenant('t3', { organization: 'acme' }, { tokenRef: 'MISSING' }),
    ]);
    try {
      expect(toGithubOrgs([tenant('t1', {}, { tokenRef: 'GH' })])).toHaveLength(
        0,
      );
      await t.svc.tick();
      expect(t.orgSync.syncOrgRepos).not.toHaveBeenCalled();
      const [o2] = toGithubOrgs([tenant('t2', { organization: 'acme' }, {})]);
      expect(await t.svc.syncOrg(o2)).toBeNull();
    } finally {
      t.restore();
    }
  });

  it('syncs every active organisation row, each with its own effective token ref', async () => {
    const { svc, orgSync, restore } = setup([
      cfgRow({
        tenantId: 't1',
        values: { organization: 'athmahealth', backfillDays: 30 },
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
      }),
      cfgRow({
        tenantId: 't1',
        key: 'nhwebsite',
        values: { organization: 'NHWebsite' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN_NHWEBSITE' },
        createdAt: new Date('2026-11-16T00:00:00Z'),
      }),
      cfgRow({
        tenantId: 't1',
        key: 'paused',
        status: 'disabled',
        values: { organization: 'Paused' },
      }),
    ]);
    try {
      await svc.tick();
      expect(orgSync.syncOrgRepos.mock.calls).toEqual([
        ['t1', 'athmahealth', 'GITHUB_TOKEN', 'tok:GITHUB_TOKEN', 30],
        [
          't1',
          'NHWebsite',
          'GITHUB_TOKEN_NHWEBSITE',
          'tok:GITHUB_TOKEN_NHWEBSITE',
          30, // blank backfillDays inherits the default row's (ADR-0013 amendment)
        ],
      ]);
    } finally {
      restore();
    }
  });

  it('a failing organisation does not stop the next one', async () => {
    const { svc, orgSync, restore } = setup([
      cfgRow({
        tenantId: 't1',
        values: { organization: 'athmahealth' },
        secretRefs: { tokenRef: 'GITHUB_TOKEN' },
      }),
      cfgRow({
        tenantId: 't1',
        key: 'nhwebsite',
        values: { organization: 'NHWebsite' },
        createdAt: new Date('2026-11-16'),
      }),
    ]);
    orgSync.syncOrgRepos.mockRejectedValueOnce(new Error('boom'));
    try {
      await svc.tick();
      expect(orgSync.syncOrgRepos).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  it("does not let one tenant's failure stop the others", async () => {
    const t = setup([
      tenant('t1', { organization: 'acme' }, { tokenRef: 'GH' }),
      tenant('t2', { organization: 'beta' }, { tokenRef: 'GH' }),
    ]);
    try {
      t.orgSync.syncOrgRepos.mockRejectedValueOnce(new Error('boom'));
      await t.svc.tick();
      expect(t.orgSync.syncOrgRepos).toHaveBeenCalledTimes(2);
    } finally {
      t.restore();
    }
  });

  it('does nothing when GITHUB_ORG_SYNC_HOURS=0', async () => {
    const t = setup(
      [tenant('t1', { organization: 'acme' }, { tokenRef: 'GH' })],
      { GITHUB_ORG_SYNC_HOURS: '0' },
    );
    try {
      await t.svc.tick();
      expect(t.prisma.tenantConfiguration.findMany).not.toHaveBeenCalled();
      expect(t.orgSync.syncOrgRepos).not.toHaveBeenCalled();
    } finally {
      t.restore();
    }
  });

  it('reads the github namespace and syncs only active rows', async () => {
    const t = setup([
      tenant('t1', { organization: 'acme' }, { tokenRef: 'GH' }),
      cfgRow({
        tenantId: 't2',
        status: 'disabled',
        values: { organization: 'beta' },
        secretRefs: { tokenRef: 'GH' },
      }),
    ]);
    try {
      await t.svc.tick();
      expect(t.prisma.tenantConfiguration.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { namespace: 'github' } }),
      );
      expect(t.orgSync.syncOrgRepos).toHaveBeenCalledTimes(1);
    } finally {
      t.restore();
    }
  });
});
