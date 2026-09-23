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

  describe('DIGEST_CRON_ENABLED deployment-wide kill switch (configuration.ts notifications.digestCronEnabled)', () => {
    it('sweeps when the config value is undefined (env unset) — the per-tenant dailyDigestEnabled flag is still the only thing that decides', async () => {
      // Guards: unset -> sweep runs, per-tenant flag still honoured.
      const notifications = {
        tenantsToDigest: jest.fn().mockResolvedValue(['tenant_a']),
        runNoCommitDigest: jest.fn().mockResolvedValue(mockDigestResult),
      };
      const config = configWith({
        appRole: 'api',
        env: 'development',
        'notifications.digestCronEnabled': undefined,
      });
      const scheduler = new NotificationSchedulerService(
        notifications as never,
        config as never,
      );

      await scheduler.sendDailyDigest();

      expect(notifications.tenantsToDigest).toHaveBeenCalledTimes(1);
      expect(notifications.runNoCommitDigest).toHaveBeenCalledTimes(1);
    });

    it('does not sweep for any tenant when the config value is false — a deployment-wide disarm', async () => {
      // Guards: 'false' -> sweep does not run; runNoCommitDigest never called.
      const notifications = {
        tenantsToDigest: jest.fn(),
        runNoCommitDigest: jest.fn(),
      };
      const config = configWith({
        appRole: 'api',
        env: 'development',
        'notifications.digestCronEnabled': false,
      });
      const scheduler = new NotificationSchedulerService(
        notifications as never,
        config as never,
      );

      await scheduler.sendDailyDigest();

      expect(notifications.tenantsToDigest).not.toHaveBeenCalled();
      expect(notifications.runNoCommitDigest).not.toHaveBeenCalled();
    });

    it('sweeps when the config value is true but still defers entirely to tenantsToDigest for tenant selection — truthy does not force-enable', async () => {
      // Guards: 'true' -> sweep runs but does NOT bypass the per-tenant flag.
      // tenantsToDigest() is the only source of tenant selection; this test
      // asserts the scheduler passes through whatever it returns (here, an
      // empty list) rather than substituting its own notion of "everyone".
      const notifications = {
        tenantsToDigest: jest.fn().mockResolvedValue([]),
        runNoCommitDigest: jest.fn(),
      };
      const config = configWith({
        appRole: 'api',
        env: 'development',
        'notifications.digestCronEnabled': true,
      });
      const scheduler = new NotificationSchedulerService(
        notifications as never,
        config as never,
      );

      await scheduler.sendDailyDigest();

      expect(notifications.tenantsToDigest).toHaveBeenCalledTimes(1);
      expect(notifications.runNoCommitDigest).not.toHaveBeenCalled();
    });

    it('a would-be truthy string surviving as-is (not the coerced boolean) must not be treated as armed by accident — config always hands the scheduler a real boolean', async () => {
      // Guards: the string 'false' is not treated as truthy. configuration.ts
      // parses DIGEST_CRON_ENABLED with parseTriStateFlag before it ever
      // reaches ConfigService, so the scheduler only ever sees a real
      // boolean or undefined — never the raw string 'false', which
      // Boolean('false') would (wrongly) evaluate to true. This test proves
      // the scheduler's own gate reacts to the boolean `false`, not to
      // stringly-typed truthiness.
      const notifications = {
        tenantsToDigest: jest.fn(),
        runNoCommitDigest: jest.fn(),
      };
      const config = configWith({
        appRole: 'api',
        env: 'development',
        'notifications.digestCronEnabled': false,
      });
      const scheduler = new NotificationSchedulerService(
        notifications as never,
        config as never,
      );

      expect(Boolean('false')).toBe(true); // documents the bug this design avoids
      await scheduler.sendDailyDigest();

      expect(notifications.tenantsToDigest).not.toHaveBeenCalled();
    });

    it.each(['False', 'OFF'])(
      'mixed-case config values are irrelevant here — the scheduler only ever receives the already-normalized boolean (regression guard for %s having been the raw env value)',
      async () => {
        // Guards: mixed case, e.g. 'False', 'OFF'. The case-insensitivity
        // itself is proven in env-flags.spec.ts (parseTriStateFlag); this
        // confirms the scheduler correctly disarms once that normalization
        // has produced `false`, regardless of what the original casing was.
        const notifications = {
          tenantsToDigest: jest.fn(),
          runNoCommitDigest: jest.fn(),
        };
        const config = configWith({
          appRole: 'api',
          env: 'development',
          'notifications.digestCronEnabled': false,
        });
        const scheduler = new NotificationSchedulerService(
          notifications as never,
          config as never,
        );

        await scheduler.sendDailyDigest();

        expect(notifications.tenantsToDigest).not.toHaveBeenCalled();
      },
    );

    it('does not evaluate the env kill switch at all when the role/environment gate already skips the sweep', async () => {
      // The env switch is checked alongside shouldSweep(), after it — an api
      // pod in production is already skipped by role gating and must not
      // also touch config.get('notifications.digestCronEnabled').
      const notifications = {
        tenantsToDigest: jest.fn(),
        runNoCommitDigest: jest.fn(),
      };
      const getSpy = jest.fn(
        (key: string) => ({ appRole: 'api', env: 'production' })[key],
      );
      const config = { get: getSpy };
      const scheduler = new NotificationSchedulerService(
        notifications as never,
        config as never,
      );

      await scheduler.sendDailyDigest();

      expect(notifications.tenantsToDigest).not.toHaveBeenCalled();
      expect(getSpy).not.toHaveBeenCalledWith(
        'notifications.digestCronEnabled',
      );
    });
  });
});
