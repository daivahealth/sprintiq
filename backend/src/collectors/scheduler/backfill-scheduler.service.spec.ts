import { PrismaService } from '../../database/prisma.service';
import { GithubPrReconcilerService } from '../sources/github/github-pr-reconciler.service';
import { GithubReviewReconcilerService } from '../sources/github/github-review-reconciler.service';
import { JiraStoryDateReconcilerService } from '../sources/jira/jira-story-date-reconciler.service';
import { BackfillSchedulerService } from './backfill-scheduler.service';

const idle = { candidates: 0, updated: 0, skipped: 0, rateLimited: false };

describe('BackfillSchedulerService', () => {
  let prisma: { tenant: { findMany: jest.Mock } };
  let reviews: jest.Mocked<GithubReviewReconcilerService>;
  let prStats: jest.Mocked<GithubPrReconcilerService>;
  let storyDates: jest.Mocked<JiraStoryDateReconcilerService>;
  let service: BackfillSchedulerService;

  beforeEach(() => {
    prisma = {
      tenant: { findMany: jest.fn().mockResolvedValue([{ id: 'tenant-a' }]) },
    };
    reviews = {
      reconcile: jest
        .fn()
        .mockResolvedValue({ ...idle, reviewsWritten: 0, remaining: 0 }),
    } as unknown as jest.Mocked<GithubReviewReconcilerService>;
    prStats = {
      reconcile: jest.fn().mockResolvedValue({ ...idle, remaining: 0 }),
    } as unknown as jest.Mocked<GithubPrReconcilerService>;
    storyDates = {
      reconcile: jest.fn().mockResolvedValue(idle),
    } as unknown as jest.Mocked<JiraStoryDateReconcilerService>;
    service = new BackfillSchedulerService(
      prisma as unknown as PrismaService,
      reviews,
      prStats,
      storyDates,
    );
  });

  it('advances every reconciler for every tenant', async () => {
    prisma.tenant.findMany.mockResolvedValue([
      { id: 'tenant-a' },
      { id: 'tenant-b' },
    ]);

    await service.tick();

    for (const svc of [storyDates, reviews, prStats]) {
      expect(svc.reconcile).toHaveBeenCalledWith('tenant-a');
      expect(svc.reconcile).toHaveBeenCalledWith('tenant-b');
    }
  });

  it('skips the rest of the sources once quota is gone', async () => {
    reviews.reconcile.mockResolvedValue({
      ...idle,
      reviewsWritten: 0,
      remaining: 500,
      rateLimited: true,
      resumeAt: new Date(Date.now() + 600_000),
    });

    await service.tick();

    // No point calling the next reconciler with an empty quota — it would
    // spend a request only to be told the same thing.
    expect(prStats.reconcile).not.toHaveBeenCalled();
  });

  it('honours the cooldown on the next tick instead of re-probing', async () => {
    reviews.reconcile.mockResolvedValue({
      ...idle,
      reviewsWritten: 0,
      remaining: 500,
      rateLimited: true,
      resumeAt: new Date(Date.now() + 600_000),
    });

    await service.tick();
    await service.tick();

    expect(reviews.reconcile).toHaveBeenCalledTimes(1);
  });

  it('resumes once the cooldown has passed', async () => {
    reviews.reconcile.mockResolvedValueOnce({
      ...idle,
      reviewsWritten: 0,
      remaining: 500,
      rateLimited: true,
      // Already elapsed.
      resumeAt: new Date(Date.now() - 1000),
    });

    await service.tick();
    await service.tick();

    expect(reviews.reconcile).toHaveBeenCalledTimes(2);
  });

  it("one tenant's failure does not abort the sweep", async () => {
    prisma.tenant.findMany.mockResolvedValue([
      { id: 'tenant-a' },
      { id: 'tenant-b' },
    ]);
    storyDates.reconcile.mockRejectedValueOnce(new Error('boom'));

    await expect(service.tick()).resolves.toBeUndefined();

    expect(storyDates.reconcile).toHaveBeenCalledWith('tenant-b');
  });
});
