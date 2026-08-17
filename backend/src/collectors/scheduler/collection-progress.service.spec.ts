import { CollectionProgressService } from './collection-progress.service';

/**
 * The convergence answer. Sync Status could already say what had *happened*
 * (runs, events, badges) but nothing anywhere said whether the tenant was
 * going to be caught up — an admin asking "will today's data be in tonight?"
 * had to infer it from log lines. The backlog counts and the projection are
 * that answer.
 */
describe('CollectionProgressService', () => {
  function build(counts: {
    reviews?: number;
    prDetail?: number;
    commitMessages?: number;
    storyDates?: number;
  }) {
    const reviews = {
      countRemaining: jest.fn().mockResolvedValue(counts.reviews ?? 0),
    };
    const prStats = {
      countRemaining: jest.fn().mockResolvedValue(counts.prDetail ?? 0),
    };
    const commitMessages = {
      countRemaining: jest.fn().mockResolvedValue(counts.commitMessages ?? 0),
    };
    const storyDates = {
      countRemaining: jest.fn().mockResolvedValue(counts.storyDates ?? 0),
    };
    return new CollectionProgressService(
      reviews as never,
      prStats as never,
      commitMessages as never,
      storyDates as never,
    );
  }

  it('reports each reconciler backlog separately, because they drain at different rates', async () => {
    const svc = build({
      reviews: 4100,
      prDetail: 200,
      commitMessages: 0,
      storyDates: 37,
    });

    const progress = await svc.getBacklog('tenant-a');

    expect(progress.reconcilers).toEqual([
      expect.objectContaining({ key: 'reviews', remaining: 4100 }),
      expect.objectContaining({ key: 'pr-detail', remaining: 200 }),
      expect.objectContaining({ key: 'commit-messages', remaining: 0 }),
      expect.objectContaining({ key: 'story-dates', remaining: 37 }),
    ]);
  });

  it('projects catch-up from the slowest reconciler, not the total', async () => {
    // They run in one sweep but each has its own per-tick batch ceiling, so
    // the tenant is caught up when the LAST one finishes. Summing the backlog
    // and dividing by a combined rate would report a time that arrives while
    // the biggest queue is still draining.
    //   reviews: 4100 ÷ 500 per 10-min tick = 9 ticks = 90 min
    //   pr-detail: 200 ÷ 200 = 1 tick = 10 min
    const svc = build({ reviews: 4100, prDetail: 200 });

    const progress = await svc.getBacklog('tenant-a');

    expect(progress.estimatedMinutesRemaining).toBe(90);
  });

  it('reports nothing outstanding as caught up, not as zero minutes away', async () => {
    // "0 minutes remaining" reads as "about to finish"; the honest statement
    // for an empty backlog is that there is no backlog.
    const svc = build({});

    const progress = await svc.getBacklog('tenant-a');

    expect(progress.caughtUp).toBe(true);
    expect(progress.estimatedMinutesRemaining).toBeNull();
  });

  it('presents the projection as a floor, since rate limits only ever slow it', async () => {
    // The reconcilers stop at a quota reserve (§3.2), so the batch ceiling is
    // a best case. Reporting it as an estimate rather than a bound would have
    // an admin expect completion at a time that cannot be beaten.
    const svc = build({ reviews: 1000 });

    const progress = await svc.getBacklog('tenant-a');

    expect(progress.estimateIsBestCase).toBe(true);
  });
});
