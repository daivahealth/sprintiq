import { GithubAuditSchedulerService } from './github-audit-scheduler.service';

function setup(tick: Record<string, unknown> | null = null) {
  const prisma = {
    schedulerTick: {
      findUnique: jest.fn().mockResolvedValue(tick),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const sync = {
    listEnabledTenants: jest.fn().mockResolvedValue(['t1', 't2']),
    runTenant: jest.fn().mockResolvedValue({ status: 'success' }),
  };
  const tenantContext = {
    runWithTenant: jest.fn(async (_t: string, fn: () => Promise<unknown>) =>
      fn(),
    ),
  };
  const svc = new GithubAuditSchedulerService(
    prisma as never,
    sync as never,
    tenantContext as never,
  );
  return { prisma, sync, tenantContext, svc };
}

describe('GithubAuditSchedulerService', () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });

  it('does nothing when the mode is off (the default)', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: '' };
    const { svc, sync, prisma } = setup();
    await svc.tick();
    expect(sync.listEnabledTenants).not.toHaveBeenCalled();
    expect(prisma.schedulerTick.upsert).not.toHaveBeenCalled();
  });

  it('runs every enabled tenant inside its own tenant context and closes the sweep', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const { svc, sync, tenantContext, prisma } = setup();
    await svc.tick();
    expect(tenantContext.runWithTenant.mock.calls.map((c) => c[0])).toEqual([
      't1',
      't2',
    ]);
    expect(sync.runTenant).toHaveBeenCalledTimes(2);
    expect(prisma.schedulerTick.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { sourceSystem: 'github-audit' },
        data: expect.objectContaining({ finishedAt: expect.any(Date) }),
      }),
    );
  });

  it('skips the tick while a recent sweep is still open', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const { svc, sync } = setup({
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: null,
    });
    await svc.tick();
    expect(sync.runTenant).not.toHaveBeenCalled();
  });

  it('one tenant failing does not stop the others, and the sweep still closes', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const { svc, sync, prisma } = setup();
    sync.runTenant.mockRejectedValueOnce(new Error('boom'));
    await svc.tick();
    expect(sync.runTenant).toHaveBeenCalledTimes(2);
    expect(prisma.schedulerTick.update).toHaveBeenCalled();
  });
});
