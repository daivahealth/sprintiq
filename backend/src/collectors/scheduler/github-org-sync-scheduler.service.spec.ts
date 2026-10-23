import { GithubOrgSyncSchedulerService } from './github-org-sync-scheduler.service';

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
) => ({ tenantId, values, secretRefs });

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
      await t.svc.tick();
      expect(t.orgSync.syncOrgRepos).not.toHaveBeenCalled();
    } finally {
      t.restore();
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

  it('reads only active github configurations', async () => {
    const t = setup([]);
    try {
      await t.svc.tick();
      expect(t.prisma.tenantConfiguration.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { namespace: 'github', key: 'default', status: 'active' },
        }),
      );
    } finally {
      t.restore();
    }
  });
});
