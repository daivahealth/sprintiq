import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { GithubReviewReconcilerService } from './github-review-reconciler.service';
import { GithubClient } from './github.client';

function pr(over: Record<string, unknown> = {}) {
  return {
    id: 'pr_1',
    connectionId: 'conn_1',
    repoFullName: 'acme/api',
    externalNumber: '1',
    ...over,
  };
}

describe('GithubReviewReconcilerService', () => {
  let prisma: {
    pullRequest: { findMany: jest.Mock; update: jest.Mock; count: jest.Mock };
    prReview: { createMany: jest.Mock; upsert: jest.Mock; findMany: jest.Mock };
    connection: { findUnique: jest.Mock };
  };
  let client: jest.Mocked<GithubClient>;
  let secrets: jest.Mocked<SecretsService>;
  let service: GithubReviewReconcilerService;

  beforeEach(() => {
    prisma = {
      pullRequest: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      prReview: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      connection: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'conn_1', secretRef: 'GITHUB_TOKEN' }),
      },
    };
    client = {
      listPullRequestReviews: jest.fn().mockResolvedValue({ reviews: [] }),
      listPullRequestReviewComments: jest
        .fn()
        .mockResolvedValue({ countByReviewId: new Map(), truncated: false }),
    } as unknown as jest.Mocked<GithubClient>;
    secrets = {
      resolve: jest.fn().mockResolvedValue('tok'),
    } as unknown as jest.Mocked<SecretsService>;
    service = new GithubReviewReconcilerService(
      prisma as unknown as PrismaService,
      secrets,
      client,
    );
  });

  it('targets PRs never fetched AND PRs whose reviews predate comment counting', async () => {
    // The second case is the trap: those PRs are already stamped
    // `reviewsFetchedAt`, so filtering on that alone would leave review_depth
    // and rubber_stamp_rate permanently empty on all existing history.
    prisma.prReview.findMany.mockResolvedValue([
      { repoFullName: 'acme/api', externalNumber: '7' },
    ]);

    await service.reconcile('tenant-a');

    expect(prisma.prReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-a', commentsCounted: false },
        distinct: ['repoFullName', 'externalNumber'],
      }),
    );
    expect(prisma.pullRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-a',
          OR: [
            { reviewsFetchedAt: null },
            { OR: [{ repoFullName: 'acme/api', externalNumber: '7' }] },
          ],
        },
      }),
    );
  });

  it('writes the timeline and derives the first review and first approval', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([pr()]);
    prisma.prReview.createMany.mockResolvedValue({ count: 2 });
    client.listPullRequestReviews.mockResolvedValue({
      reviews: [
        {
          externalId: '20',
          reviewerLogin: 'asmith',
          isBot: false,
          state: 'approved',
          submittedAt: '2026-06-03T10:00:00.000Z',
          hasBody: false,
        },
        {
          externalId: '10',
          reviewerLogin: 'bjones',
          isBot: false,
          state: 'commented',
          submittedAt: '2026-06-01T09:00:00.000Z',
          hasBody: true,
        },
      ],
    });

    const result = await service.reconcile('tenant-a');

    expect(prisma.pullRequest.update).toHaveBeenCalledWith({
      where: { id: 'pr_1' },
      data: {
        firstReviewAt: new Date('2026-06-01T09:00:00.000Z'),
        approvedAt: new Date('2026-06-03T10:00:00.000Z'),
        reviewsFetchedAt: expect.any(Date),
      },
    });
    expect(result).toMatchObject({ updated: 1, reviewsWritten: 2 });
  });

  it('stamps a genuinely unreviewed PR as fetched, so it stops being a candidate', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([pr()]);
    client.listPullRequestReviews.mockResolvedValue({ reviews: [] });

    await service.reconcile('tenant-a');

    // "We asked and there were none" is an answer — without the stamp this PR
    // would be re-fetched forever and stay excluded from review coverage.
    const data = prisma.pullRequest.update.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(data.reviewsFetchedAt).toBeInstanceOf(Date);
    expect(data.firstReviewAt).toBeNull();
    expect(prisma.prReview.createMany).not.toHaveBeenCalled();
  });

  it('does NOT stamp a PR whose request failed, leaving it a candidate', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([pr()]);
    client.listPullRequestReviews.mockResolvedValue({
      reviews: [],
      failed: true,
    });

    const result = await service.reconcile('tenant-a');

    // Stamping here would record "merged with no review" — a reportable
    // finding — as fact, on the strength of a 500.
    expect(prisma.pullRequest.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, skipped: 1 });
  });

  it('stops on a rate limit and reports what is left for the next run', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([
      pr({ id: 'pr_1', externalNumber: '1' }),
      pr({ id: 'pr_2', externalNumber: '2' }),
    ]);
    client.listPullRequestReviews.mockResolvedValue({
      reviews: [],
      rateLimitedUntil: new Date(Date.now() + 60_000),
    });
    prisma.pullRequest.count.mockResolvedValue(2);

    const result = await service.reconcile('tenant-a');

    expect(result.rateLimited).toBe(true);
    expect(result.remaining).toBe(2);
    expect(prisma.pullRequest.update).not.toHaveBeenCalled();
  });

  it('attributes inline comment counts to each review', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([pr()]);
    client.listPullRequestReviews.mockResolvedValue({
      reviews: [
        {
          externalId: '10',
          reviewerLogin: 'bjones',
          isBot: false,
          state: 'approved',
          submittedAt: '2026-06-01T09:00:00.000Z',
          hasBody: false,
        },
      ],
    });
    client.listPullRequestReviewComments.mockResolvedValue({
      countByReviewId: new Map([['10', 4]]),
      truncated: false,
    });

    await service.reconcile('tenant-a');

    const arg = prisma.prReview.upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.create).toMatchObject({
      commentCount: 4,
      commentsCounted: true,
    });
    // The update path is what backfills a review collected before comment
    // counting existed — createMany(skipDuplicates) would leave it at 0.
    expect(arg.update).toMatchObject({
      commentCount: 4,
      commentsCounted: true,
    });
  });

  it('marks comments as NOT counted when that request failed', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([pr()]);
    client.listPullRequestReviews.mockResolvedValue({
      reviews: [
        {
          externalId: '10',
          reviewerLogin: 'bjones',
          isBot: false,
          state: 'approved',
          submittedAt: '2026-06-01T09:00:00.000Z',
          hasBody: false,
        },
      ],
    });
    client.listPullRequestReviewComments.mockResolvedValue({
      countByReviewId: new Map(),
      truncated: false,
      failed: true,
    });

    await service.reconcile('tenant-a');

    // An uncounted zero must never become a rubber-stamp finding.
    const arg = prisma.prReview.upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.create).toMatchObject({
      commentCount: 0,
      commentsCounted: false,
    });
    // And a failed count must not reset a good one already stored.
    expect(arg.update).not.toHaveProperty('commentCount');
  });

  it('skips the comments call entirely for a PR with no reviews', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([pr()]);
    client.listPullRequestReviews.mockResolvedValue({ reviews: [] });

    await service.reconcile('tenant-a');

    // Nothing to attribute comments to — that PR costs one call, not two.
    expect(client.listPullRequestReviewComments).not.toHaveBeenCalled();
  });

  it('converges on one row per review id on replay rather than inflating reviewer load', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([pr()]);
    client.listPullRequestReviews.mockResolvedValue({
      reviews: [
        {
          externalId: '10',
          reviewerLogin: 'bjones',
          isBot: false,
          state: 'approved',
          submittedAt: '2026-06-01T09:00:00.000Z',
          hasBody: true,
        },
      ],
    });

    await service.reconcile('tenant-a');

    expect(prisma.prReview.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_externalId: { tenantId: 'tenant-a', externalId: '10' },
        },
      }),
    );
  });

  it('re-classifies isBot on replay, correcting rows the migration could only guess from the login', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([pr()]);
    client.listPullRequestReviews.mockResolvedValue({
      reviews: [
        {
          externalId: '10',
          // A service account with an ordinary login: the `[bot]` suffix
          // backfill could not catch this, only GitHub's `user.type` can.
          reviewerLogin: 'ci-deploy',
          isBot: true,
          state: 'approved',
          submittedAt: '2026-06-01T09:00:00.000Z',
          hasBody: false,
        },
      ],
    });

    await service.reconcile('tenant-a');

    const arg = prisma.prReview.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(arg.update.isBot).toBe(true);
  });
});
