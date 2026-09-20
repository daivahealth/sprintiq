import { NotificationSchedulerService } from './notification-scheduler.service';

describe('NotificationSchedulerService', () => {
  // Realistic RunDigestResult shape returned by the service at runtime.
  const mockDigestResult = {
    reportedDay: '2026-09-17',
    outcome: 'sent' as const,
    flagged: [],
    unresolved: [],
    incomplete: [],
    detail: null,
    dryRun: false,
  };

  function configWith(values: Record<string, unknown>) {
    return { get: jest.fn((key: string) => values[key]) };
  }

  it('runs the digest once per configured tenant and exercises the success path', async () => {
    // This test verifies both the sweep cardinality (once per tenant) and
    // the success log path (the scheduler's logger must access reportedDay
    // and flagged.length without error on successful runs). Dev/test config
    // (env=development, no explicit role) must still sweep.
    const notifications = {
      tenantsToDigest: jest.fn().mockResolvedValue(['tenant_a', 'tenant_b']),
      runNoCommitDigest: jest
        .fn()
        .mockResolvedValueOnce(mockDigestResult)
        .mockResolvedValueOnce(mockDigestResult),
    };
    const config = configWith({ appRole: 'api', env: 'development' });
    const scheduler = new NotificationSchedulerService(
      notifications as never,
      config as never,
    );

    await scheduler.sendDailyDigest();

    expect(notifications.runNoCommitDigest).toHaveBeenCalledTimes(2);
  });

  it('continues to the next tenant when one fails and guards per-tenant isolation', async () => {
    // One tenant's broken webhook must not cancel everyone else's digest.
    // The per-tenant try/catch ensures tenant_b runs even when tenant_a throws.
    const notifications = {
      tenantsToDigest: jest.fn().mockResolvedValue(['tenant_a', 'tenant_b']),
      runNoCommitDigest: jest
        .fn()
        .mockRejectedValueOnce(new Error('403'))
        .mockResolvedValueOnce(mockDigestResult),
    };
    const config = configWith({ appRole: 'worker', env: 'production' });
    const scheduler = new NotificationSchedulerService(
      notifications as never,
      config as never,
    );

    await expect(scheduler.sendDailyDigest()).resolves.toBeUndefined();
    expect(notifications.runNoCommitDigest).toHaveBeenCalledTimes(2);
  });

  describe('role gating (docs/deployment/README.md §1: egress is collector/worker-only, never api)', () => {
    it('sweeps on the worker role in production', async () => {
      const notifications = {
        tenantsToDigest: jest.fn().mockResolvedValue(['tenant_a']),
        runNoCommitDigest: jest.fn().mockResolvedValue(mockDigestResult),
      };
      const config = configWith({ appRole: 'worker', env: 'production' });
      const scheduler = new NotificationSchedulerService(
        notifications as never,
        config as never,
      );

      await scheduler.sendDailyDigest();

      expect(notifications.tenantsToDigest).toHaveBeenCalledTimes(1);
    });

    it('skips the sweep on the api role in production — the same image runs api/collector/worker pods of one cron', async () => {
      // The actual bug this finding fixes: with no gate, an `api` pod fires
      // this cron too, and production runs api + collector + worker pods of
      // the same image, so the digest would post three times a day.
      const notifications = {
        tenantsToDigest: jest.fn().mockResolvedValue(['tenant_a']),
        runNoCommitDigest: jest.fn().mockResolvedValue(mockDigestResult),
      };
      const config = configWith({ appRole: 'api', env: 'production' });
      const scheduler = new NotificationSchedulerService(
        notifications as never,
        config as never,
      );

      await scheduler.sendDailyDigest();

      expect(notifications.tenantsToDigest).not.toHaveBeenCalled();
      expect(notifications.runNoCommitDigest).not.toHaveBeenCalled();
    });

    it('skips the sweep on the collector role in production', async () => {
      const notifications = {
        tenantsToDigest: jest.fn().mockResolvedValue(['tenant_a']),
        runNoCommitDigest: jest.fn().mockResolvedValue(mockDigestResult),
      };
      const config = configWith({ appRole: 'collector', env: 'production' });
      const scheduler = new NotificationSchedulerService(
        notifications as never,
        config as never,
      );

      await scheduler.sendDailyDigest();

      expect(notifications.tenantsToDigest).not.toHaveBeenCalled();
    });

    it('sweeps on the default (api) role outside production — dev runs all roles in one process', async () => {
      // docs/deployment/README.md §1: "In dev, all three roles run in one
      // process", and that process's APP_ROLE defaults to `api`
      // (.env.example, docker-compose.yml). Gating on role alone would
      // silently stop the digest from ever firing in dev.
      const notifications = {
        tenantsToDigest: jest.fn().mockResolvedValue(['tenant_a']),
        runNoCommitDigest: jest.fn().mockResolvedValue(mockDigestResult),
      };
      const config = configWith({ appRole: 'api', env: 'development' });
      const scheduler = new NotificationSchedulerService(
        notifications as never,
        config as never,
      );

      await scheduler.sendDailyDigest();

      expect(notifications.tenantsToDigest).toHaveBeenCalledTimes(1);
    });

    it('sweeps under the Jest/test environment regardless of role', async () => {
      const notifications = {
        tenantsToDigest: jest.fn().mockResolvedValue(['tenant_a']),
        runNoCommitDigest: jest.fn().mockResolvedValue(mockDigestResult),
      };
      const config = configWith({ appRole: 'api', env: 'test' });
      const scheduler = new NotificationSchedulerService(
        notifications as never,
        config as never,
      );

      await scheduler.sendDailyDigest();

      expect(notifications.tenantsToDigest).toHaveBeenCalledTimes(1);
    });

    it('defaults to sweeping when config values are missing entirely', async () => {
      const notifications = {
        tenantsToDigest: jest.fn().mockResolvedValue([]),
        runNoCommitDigest: jest.fn(),
      };
      const config = configWith({});
      const scheduler = new NotificationSchedulerService(
        notifications as never,
        config as never,
      );

      await scheduler.sendDailyDigest();

      expect(notifications.tenantsToDigest).toHaveBeenCalledTimes(1);
    });
  });
});
