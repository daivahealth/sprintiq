import { NotificationSchedulerService } from './notification-scheduler.service';

describe('NotificationSchedulerService', () => {
  it('runs the digest once per configured tenant', async () => {
    const notifications = {
      tenantsToDigest: jest.fn().mockResolvedValue(['tenant_a', 'tenant_b']),
      runNoCommitDigest: jest.fn().mockResolvedValue({ outcome: 'sent' }),
    };
    const scheduler = new NotificationSchedulerService(notifications as never);

    await scheduler.sendDailyDigest();

    expect(notifications.runNoCommitDigest).toHaveBeenCalledTimes(2);
  });

  it('continues to the next tenant when one fails', async () => {
    // One tenant's broken webhook must not cancel everyone else's digest.
    const notifications = {
      tenantsToDigest: jest.fn().mockResolvedValue(['tenant_a', 'tenant_b']),
      runNoCommitDigest: jest
        .fn()
        .mockRejectedValueOnce(new Error('403'))
        .mockResolvedValueOnce({ outcome: 'sent' }),
    };
    const scheduler = new NotificationSchedulerService(notifications as never);

    await expect(scheduler.sendDailyDigest()).resolves.toBeUndefined();
    expect(notifications.runNoCommitDigest).toHaveBeenCalledTimes(2);
  });
});
