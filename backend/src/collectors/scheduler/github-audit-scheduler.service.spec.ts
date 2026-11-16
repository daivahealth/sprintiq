import { Logger } from '@nestjs/common';
import { GithubAuditSchedulerService } from './github-audit-scheduler.service';

function setup(
  tick: Record<string, unknown> | null = null,
  config: Record<string, unknown> = {},
) {
  const prisma = {
    schedulerTick: {
      findUnique: jest.fn().mockResolvedValue(tick),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const sync = {
    listEnabledOrgs: jest.fn().mockResolvedValue([
      { tenantId: 't1', organization: 'acme' },
      { tenantId: 't2', organization: 'acme' },
    ]),
    runTenant: jest.fn().mockResolvedValue({ status: 'success' }),
    runFullSweep: jest.fn().mockResolvedValue({ status: 'success' }),
  };
  const tenantContext = {
    runWithTenant: jest.fn(async (_t: string, fn: () => Promise<unknown>) =>
      fn(),
    ),
  };
  const configService = { get: jest.fn((key: string) => config[key]) };
  const svc = new GithubAuditSchedulerService(
    prisma as never,
    sync as never,
    tenantContext as never,
    configService as never,
  );
  return { prisma, sync, tenantContext, svc };
}

describe('GithubAuditSchedulerService', () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
    jest.restoreAllMocks();
  });

  it('does nothing when the mode is off (the default)', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: '' };
    const { svc, sync, prisma } = setup();
    await svc.tick();
    expect(sync.listEnabledOrgs).not.toHaveBeenCalled();
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

  it('runs every enabled organisation of a tenant, one after another', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const order: string[] = [];
    const { svc, sync } = setup();
    sync.listEnabledOrgs.mockResolvedValue([
      { tenantId: 't1', organization: 'athmahealth' },
      { tenantId: 't1', organization: 'NHWebsite' },
    ]);
    sync.runTenant.mockImplementation(
      async (_t: string, _c: unknown, _n: unknown, org: string) => {
        order.push(`start:${org}`);
        await Promise.resolve();
        order.push(`end:${org}`);
        return { tenantId: 't1', status: 'success', counters: {}, durationMs: 0 };
      },
    );

    await svc.tick();

    expect(order).toEqual([
      'start:athmahealth',
      'end:athmahealth',
      'start:NHWebsite',
      'end:NHWebsite',
    ]);
    expect(sync.runTenant).toHaveBeenCalledWith('t1', expect.anything(), undefined, 'NHWebsite');
  });

  it('a throwing organisation never stops the next', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const { svc, sync } = setup();
    sync.listEnabledOrgs.mockResolvedValue([
      { tenantId: 't1', organization: 'athmahealth' },
      { tenantId: 't1', organization: 'NHWebsite' },
    ]);
    sync.runTenant.mockRejectedValueOnce(new Error('boom'));
    sync.runTenant.mockResolvedValueOnce({ tenantId: 't1', status: 'success', counters: {}, durationMs: 0 });
    await svc.tick();
    expect(sync.runTenant).toHaveBeenCalledTimes(2);
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

  it('does not sweep from a non-worker pod in production', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const { svc, sync, prisma } = setup(null, {
      env: 'production',
      appRole: 'api',
    });
    await svc.tick();
    expect(sync.listEnabledOrgs).not.toHaveBeenCalled();
    expect(prisma.schedulerTick.findUnique).not.toHaveBeenCalled();
  });

  it('sweeps from the worker pod in production', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const { svc, sync } = setup(null, {
      env: 'production',
      appRole: 'worker',
    });
    await svc.tick();
    expect(sync.runTenant).toHaveBeenCalledTimes(2);
  });

  it('logs the reason when a tenant run is skipped', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const { svc, sync } = setup();
    sync.runTenant.mockResolvedValueOnce({
      tenantId: 't1',
      status: 'skipped',
      reason: 'Another audit sync run for this tenant is in progress.',
    });
    await svc.tick();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /t1.*Another audit sync run for this tenant is in progress\./,
      ),
    );
  });
});

describe('GithubAuditSchedulerService.sweepTick (full branch sweep)', () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
    jest.restoreAllMocks();
  });

  it('does nothing when the mode is off', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: '' };
    const { svc, sync, prisma } = setup();
    await svc.sweepTick();
    expect(sync.listEnabledOrgs).not.toHaveBeenCalled();
    expect(prisma.schedulerTick.findUnique).not.toHaveBeenCalled();
  });

  it('does nothing when GITHUB_AUDIT_FULL_SWEEP_MINUTES is 0, even with the mode on', async () => {
    process.env = {
      ...env,
      GITHUB_AUDIT_SYNC_MODE: 'ingest',
      GITHUB_AUDIT_FULL_SWEEP_MINUTES: '0',
    };
    const { svc, sync, prisma } = setup();
    await svc.sweepTick();
    expect(sync.listEnabledOrgs).not.toHaveBeenCalled();
    expect(sync.runFullSweep).not.toHaveBeenCalled();
    expect(prisma.schedulerTick.findUnique).not.toHaveBeenCalled();
  });

  it('runs the sweep for every enabled tenant in its own tenant context, under its own tick key', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const { svc, sync, tenantContext, prisma } = setup();
    await svc.sweepTick();
    expect(tenantContext.runWithTenant.mock.calls.map((c) => c[0])).toEqual([
      't1',
      't2',
    ]);
    expect(sync.runFullSweep).toHaveBeenCalledTimes(2);
    expect(sync.runTenant).not.toHaveBeenCalled();
    expect(prisma.schedulerTick.findUnique).toHaveBeenCalledWith({
      where: { sourceSystem: 'github-audit-sweep' },
    });
    expect(prisma.schedulerTick.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sourceSystem: 'github-audit-sweep' },
      }),
    );
    expect(prisma.schedulerTick.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { sourceSystem: 'github-audit-sweep' },
        data: expect.objectContaining({ finishedAt: expect.any(Date) }),
      }),
    );
  });

  it('skips while a recent sweep is still open, but takes over one older than twice the interval', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const recent = setup({
      startedAt: new Date(Date.now() - 60 * 60_000),
      finishedAt: null,
    });
    await recent.svc.sweepTick();
    expect(recent.sync.runFullSweep).not.toHaveBeenCalled();

    const stale = setup({
      startedAt: new Date(Date.now() - 121 * 60_000),
      finishedAt: null,
    });
    await stale.svc.sweepTick();
    expect(stale.sync.runFullSweep).toHaveBeenCalledTimes(2);
  });

  it('one tenant failing does not stop the others, and the sweep still closes', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const { svc, sync, prisma } = setup();
    sync.runFullSweep.mockRejectedValueOnce(new Error('boom'));
    await svc.sweepTick();
    expect(sync.runFullSweep).toHaveBeenCalledTimes(2);
    expect(prisma.schedulerTick.update).toHaveBeenCalled();
  });

  it('does not sweep from a non-worker pod in production', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const { svc, sync, prisma } = setup(null, {
      env: 'production',
      appRole: 'api',
    });
    await svc.sweepTick();
    expect(sync.listEnabledOrgs).not.toHaveBeenCalled();
    expect(prisma.schedulerTick.findUnique).not.toHaveBeenCalled();
  });

  it('sweeps from the worker pod in production', async () => {
    process.env = { ...env, GITHUB_AUDIT_SYNC_MODE: 'shadow' };
    const { svc, sync } = setup(null, {
      env: 'production',
      appRole: 'worker',
    });
    await svc.sweepTick();
    expect(sync.runFullSweep).toHaveBeenCalledTimes(2);
  });
});
