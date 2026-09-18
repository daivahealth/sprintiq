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

  it('runs the digest once per configured tenant and exercises the success path', async () => {
    // This test verifies both the sweep cardinality (once per tenant) and
    // the success log path (the scheduler's logger must access reportedDay
    // and flagged.length without error on successful runs).
    const notifications = {
      tenantsToDigest: jest.fn().mockResolvedValue(['tenant_a', 'tenant_b']),
      runNoCommitDigest: jest
        .fn()
        .mockResolvedValueOnce(mockDigestResult)
        .mockResolvedValueOnce(mockDigestResult),
    };
    const scheduler = new NotificationSchedulerService(notifications as never);

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
    const scheduler = new NotificationSchedulerService(notifications as never);

    await expect(scheduler.sendDailyDigest()).resolves.toBeUndefined();
    expect(notifications.runNoCommitDigest).toHaveBeenCalledTimes(2);
  });
});
