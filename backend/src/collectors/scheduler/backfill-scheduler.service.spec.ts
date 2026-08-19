import { PrismaService } from '../../database/prisma.service';
import { GithubCommitMessageReconcilerService } from '../sources/github/github-commit-message-reconciler.service';
import { GithubPrReconcilerService } from '../sources/github/github-pr-reconciler.service';
import { GithubReviewReconcilerService } from '../sources/github/github-review-reconciler.service';
import { JiraStoryDateReconcilerService } from '../sources/jira/jira-story-date-reconciler.service';
import { BackfillSchedulerService } from './backfill-scheduler.service';

const idle = { candidates: 0, updated: 0, skipped: 0, rateLimited: false };

describe('BackfillSchedulerService', () => {
  let prisma: { tenant: { findMany: jest.Mock } };
  let reviews: jest.Mocked<GithubReviewReconcilerService>;
  let prStats: jest.Mocked<GithubPrReconcilerService>;
  let commitMessages: jest.Mocked<GithubCommitMessageReconcilerService>;
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
    commitMessages = {
      reconcile: jest.fn().mockResolvedValue({ ...idle, remaining: 0 }),
    } as unknown as jest.Mocked<GithubCommitMessageReconcilerService>;
    storyDates = {
      reconcile: jest.fn().mockResolvedValue(idle),
    } as unknown as jest.Mocked<JiraStoryDateReconcilerService>;
    service = new BackfillSchedulerService(
      prisma as unknown as PrismaService,
      reviews,
      prStats,
      commitMessages,
      storyDates,
    );
  });

  it('advances every reconciler for every tenant', async () => {
    prisma.tenant.findMany.mockResolvedValue([
      { id: 'tenant-a' },
      { id: 'tenant-b' },
    ]);

    await service.tick();

    for (const svc of [storyDates, reviews, prStats, commitMessages]) {
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
    expect(commitMessages.reconcile).not.toHaveBeenCalled();
  });

  it('skips commit messages when PR stats exhausted the quota', async () => {
    prStats.reconcile.mockResolvedValue({
      ...idle,
      remaining: 500,
      rateLimited: true,
      resumeAt: new Date(Date.now() + 600_000),
    });

    await service.tick();

    expect(commitMessages.reconcile).not.toHaveBeenCalled();
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

  it('keeps filling Jira gaps while GitHub sits out its cooldown', async () => {
    // The cooldown was keyed per TENANT and checked before any reconciler ran,
    // so GitHub exhausting its quota skipped the whole tenant — Jira's
    // story-date reconciler included. The two sources hold different
    // credentials against different rate limits, and Jira cannot report a
    // cooldown at all (`StoryDateReconcileResult` has no `resumeAt`), so it
    // was being punished for a limit it can never hit. During a 195-repo
    // backfill GitHub is in cooldown most of the time, which would have
    // stalled Jira gap-filling for days.
    reviews.reconcile.mockResolvedValue({
      ...idle,
      reviewsWritten: 0,
      remaining: 500,
      rateLimited: true,
      resumeAt: new Date(Date.now() + 600_000),
    });

    await service.tick();
    await service.tick();

    expect(storyDates.reconcile).toHaveBeenCalledTimes(2);
    // GitHub still correctly sits out — the protection it needs is intact.
    expect(reviews.reconcile).toHaveBeenCalledTimes(1);
  });

  it('holds one tenant cooldown without silencing another tenant', async () => {
    prisma.tenant.findMany.mockResolvedValue([
      { id: 'tenant-a' },
      { id: 'tenant-b' },
    ]);
    reviews.reconcile.mockResolvedValueOnce({
      ...idle,
      reviewsWritten: 0,
      remaining: 500,
      rateLimited: true,
      resumeAt: new Date(Date.now() + 600_000),
    });

    await service.tick();

    // tenant-a exhausted its own token; tenant-b's is untouched.
    expect(reviews.reconcile).toHaveBeenCalledTimes(2);
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
