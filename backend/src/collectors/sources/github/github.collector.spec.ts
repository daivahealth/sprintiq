import { Connection } from '@prisma/client';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { ConnectionsService } from '../../../modules/connections/connections.service';
import {
  GithubClient,
  GithubPage,
  GithubPull,
  GithubCommit,
} from './github.client';
import { GithubCollector } from './github.collector';

function baseConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn_1',
    tenantId: 'tenant-a',
    sourceSystem: 'github',
    name: 'acme/payments',
    config: { repoFullName: 'acme/payments' },
    secretRef: 'GITHUB_TOKEN',
    webhookSecretRef: null,
    syncCursors: {},
    rateLimitState: {},
    status: 'active',
    lastSyncAt: null,
    syncLagSeconds: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Connection;
}

/**
 * A PR inside the default backfill window, expressed relative to now.
 *
 * `baseConnection()` sets no `config.backfillSince`, so the collector recomputes
 * its floor as `now - DEFAULT_BACKFILL_DAYS` on every tick. A pinned literal
 * here therefore has a shelf life: this fixture read `2026-06-01`, the floor
 * reached that date on 2026-08-30, and nine tests began failing on a clock tick
 * rather than a code change — asserting nothing about the collector from then
 * on, since the walk stopped at the floor before enriching anything.
 */
function pull(overrides: Partial<GithubPull>): GithubPull {
  const withinWindow = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  return {
    number: 1,
    title: 't',
    state: 'open',
    merged_at: null,
    created_at: withinWindow,
    updated_at: withinWindow,
    ...overrides,
  };
}

function emptyCommitsPage(): GithubPage<GithubCommit> {
  return { items: [], hasNextPage: false };
}

describe('GithubCollector.poll', () => {
  let client: jest.Mocked<GithubClient>;
  let connections: jest.Mocked<ConnectionsService>;
  let secrets: jest.Mocked<SecretsService>;
  let collector: GithubCollector;

  beforeEach(() => {
    client = {
      // The transport identity matters: `pageRef` restarts a walk whose
      // persisted cursors were written by the *other* mode, so a mock without
      // it would look like a mode switch on every poll.
      mode: 'rest',
      listPullRequestsPage: jest.fn(),
      listCommitsPage: jest.fn(),
      getCommitDetail: jest
        .fn()
        .mockResolvedValue({ additions: 3, deletions: 1 }),
      getPullRequestDetail: jest
        .fn()
        .mockResolvedValue({ additions: 10, deletions: 5, changedFiles: 2 }),
      listPullRequestCommits: jest.fn().mockResolvedValue({ messages: [] }),
      listPullRequestReviews: jest.fn().mockResolvedValue({ reviews: [] }),
      listPullRequestReviewComments: jest
        .fn()
        .mockResolvedValue({ countByReviewId: new Map(), truncated: false }),
    } as unknown as jest.Mocked<GithubClient>;
    connections = {
      setSyncCursors: jest.fn().mockResolvedValue(undefined),
      setRateLimitState: jest.fn().mockResolvedValue(undefined),
      setBackfillCompletedAt: jest.fn().mockResolvedValue(undefined),
      updateConfig: jest.fn().mockResolvedValue(undefined),
      setSyncHealth: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ConnectionsService>;
    secrets = {
      resolve: jest.fn().mockResolvedValue('tok'),
    } as unknown as jest.Mocked<SecretsService>;
    collector = new GithubCollector(client, connections, secrets);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('reports a rate-limit cooldown as skipped, not as an empty success', async () => {
    // The distinction is what stops the scheduler stamping lastSyncAt on a
    // connection this pass never called GitHub for.
    const connection = baseConnection({
      rateLimitState: { resetAt: new Date(Date.now() + 60_000).toISOString() },
    });

    const result = await collector.poll(connection);

    expect(result).toEqual({ envelopes: [], skipped: 'rate-limited' });
    expect(client.listPullRequestsPage).not.toHaveBeenCalled();
  });

  it('reports a missing credential as skipped, not as an empty success', async () => {
    secrets.resolve.mockResolvedValue('');
    const result = await collector.poll(baseConnection());
    expect(result).toEqual({ envelopes: [], skipped: 'no-credential' });
  });

  it('reports an unconfigured connection as skipped, not as an empty success', async () => {
    const result = await collector.poll(baseConnection({ config: {} }));
    expect(result).toEqual({ envelopes: [], skipped: 'not-configured' });
  });

  it('backfills PRs newer than the floor and stops at the floor, tagging mode=backfill', async () => {
    const floor = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const within = pull({
      number: 1,
      updated_at: new Date(floor.getTime() + 60_000).toISOString(),
    });
    const beyond = pull({
      number: 2,
      updated_at: new Date(floor.getTime() - 60_000).toISOString(),
    });
    client.listPullRequestsPage.mockResolvedValue({
      items: [within, beyond],
      hasNextPage: true,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());

    const { envelopes } = await collector.poll(baseConnection());

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].collectionMode).toBe('backfill');
    expect(envelopes[0].externalRefs.pr_number).toBe('1');
    expect(client.getPullRequestDetail).toHaveBeenCalledWith(
      'acme/payments',
      'tok',
      1,
    );
    expect(envelopes[0].data).toMatchObject({
      additions: 10,
      deletions: 5,
      changedFiles: 2,
    });

    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(cursors.prBackfillDone).toBe(true);
    expect(cursors.prPage).toBeUndefined();
    expect(cursors.prNewestSeenAt).toBe(within.updated_at);
  });

  it('defers un-enriched PRs to a later tick once the backfill enrichment budget runs out', async () => {
    const pulls = Array.from({ length: 30 }, (_, i) =>
      pull({ number: i + 1, updated_at: new Date().toISOString() }),
    );
    client.listPullRequestsPage.mockResolvedValue({
      items: pulls,
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());

    const { envelopes } = await collector.poll(baseConnection());

    expect(envelopes).toHaveLength(25);
    expect(client.getPullRequestDetail).toHaveBeenCalledTimes(25);
    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    // Resumes the SAME page, but at the exact item the budget ran out on —
    // without the offset the next tick would re-enrich items 0-24 forever and
    // the page (and therefore the whole backfill) would never advance.
    expect(cursors.prPage).toBe(1);
    expect(cursors.prPageOffset).toBe(25);
    expect(cursors.prBackfillDone).toBeUndefined();
  });

  it('divides the enrich budget across a tenant peers, so every repo advances each sweep', async () => {
    // The per-connection budget was a constant, so it MULTIPLIED by fleet
    // size: 195 repos × 25 PRs × 4 calls ≈ 19,500 requests against a 5,000/hr
    // limit. The first ~30 connections spent the whole hour's quota and the
    // remaining 165 were rate-limited having collected nothing — every sweep,
    // forever. A fleet budget divided across peers is what makes the tail
    // reachable at all.
    const pulls = Array.from({ length: 30 }, (_, i) =>
      pull({ number: i + 1, updated_at: new Date().toISOString() }),
    );
    client.listPullRequestsPage.mockResolvedValue({
      items: pulls,
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());

    const { envelopes } = await collector.poll(baseConnection(), {
      peersDue: 195,
    });

    // 500-PR sweep budget ÷ 195 due connections ≈ 2 each.
    expect(envelopes.length).toBeGreaterThan(0);
    expect(envelopes.length).toBeLessThanOrEqual(3);
  });

  it('leaves a small tenant at the full per-connection budget', async () => {
    // Dividing must not penalise the deployment the constant was tuned for:
    // with few connections the fleet budget exceeds the per-tick ceiling and
    // the ceiling still governs.
    const pulls = Array.from({ length: 30 }, (_, i) =>
      pull({ number: i + 1, updated_at: new Date().toISOString() }),
    );
    client.listPullRequestsPage.mockResolvedValue({
      items: pulls,
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());

    const { envelopes } = await collector.poll(baseConnection(), {
      peersDue: 2,
    });

    expect(envelopes).toHaveLength(25);
  });

  it('never divides the budget below one PR, so no connection can stall completely', async () => {
    // Integer division at extreme fleet sizes floors to 0, which would make a
    // connection poll forever without ever enriching anything — progress would
    // stop while every tick still spent its list-page calls.
    const pulls = Array.from({ length: 30 }, (_, i) =>
      pull({ number: i + 1, updated_at: new Date().toISOString() }),
    );
    client.listPullRequestsPage.mockResolvedValue({
      items: pulls,
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());

    const { envelopes } = await collector.poll(baseConnection(), {
      peersDue: 100_000,
    });

    expect(envelopes).toHaveLength(1);
  });

  it('reports how far back it has walked while still backfilling, so recent windows can be judged complete', async () => {
    // GitHub walks newest-first, so a backfilling connection is genuinely
    // complete over the recent end long before the whole window is in. Without
    // the lower bound the dashboards can only say "incomplete" for days, even
    // for a board showing the last 7 days over data that is fully collected.
    const at = (day: number) => new Date(Date.UTC(2026, 7, day)).toISOString();
    client.listPullRequestsPage.mockResolvedValue({
      items: [17, 16, 15].map((d) => pull({ number: d, updated_at: at(d) })),
      hasNextPage: true,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());

    const result = await collector.poll(baseConnection());

    // Walked back to the oldest PR it actually enriched — not to the floor it
    // is aiming at, which it has not reached.
    expect(result.collectedBackTo).toEqual(new Date(at(15)));
  });

  it('reports the backfill floor as the lower bound once the walk is finished', async () => {
    const floor = new Date(Date.UTC(2025, 7, 17));
    client.listPullRequestsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());

    const result = await collector.poll(
      baseConnection({
        config: {
          repoFullName: 'acme/payments',
          backfillSince: floor.toISOString(),
        },
        syncCursors: {
          prBackfillDone: true,
          prNewestSeenAt: '2026-08-17T00:00:00.000Z',
          commitsCursor: '2026-08-17T00:00:00.000Z',
        },
      }),
    );

    expect(result.collectedBackTo).toEqual(floor);
  });

  it('converges in incremental mode when more PRs changed than the budget covers', async () => {
    // The divided budget made this the normal case, not an edge one: at 195
    // peers a connection gets 2 PRs per tick, so any repo with 3+ PRs touched
    // between ticks used to enrich the same newest 2 forever and never advance
    // — burning its whole share on work the idempotency key then discarded.
    const updatedAt = (n: number) =>
      new Date(Date.UTC(2026, 7, 17, n)).toISOString();
    // Sorted desc, as GitHub returns them. All five are newer than the watermark.
    const pulls = [5, 4, 3, 2, 1].map((n) =>
      pull({ number: n, updated_at: updatedAt(n) }),
    );
    client.listPullRequestsPage.mockResolvedValue({
      items: pulls,
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());
    const connection = baseConnection({
      syncCursors: {
        prBackfillDone: true,
        commitsCursor: updatedAt(0),
        prNewestSeenAt: updatedAt(0),
      },
    });

    const { envelopes } = await collector.poll(connection, { peersDue: 195 });

    // Works the OLDEST unsynced PRs first, so the watermark can move.
    expect(envelopes).toHaveLength(2);
    expect(envelopes.map((e) => e.externalRefs.pr_number)).toEqual(['1', '2']);
    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(cursors.prNewestSeenAt).toBe(updatedAt(2));
  });

  it('never advances the incremental watermark past a PR it did not enrich', async () => {
    // The other half of the same rule: advancing to the newest item would skip
    // everything the budget did not reach, permanently.
    const updatedAt = (n: number) =>
      new Date(Date.UTC(2026, 7, 17, n)).toISOString();
    const pulls = [5, 4, 3, 2, 1].map((n) =>
      pull({ number: n, updated_at: updatedAt(n) }),
    );
    client.listPullRequestsPage.mockResolvedValue({
      items: pulls,
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());

    await collector.poll(
      baseConnection({
        syncCursors: {
          prBackfillDone: true,
          commitsCursor: updatedAt(0),
          prNewestSeenAt: updatedAt(0),
        },
      }),
      { peersDue: 195 },
    );

    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(cursors.prNewestSeenAt).not.toBe(updatedAt(5));
  });

  it('resumes mid-page from prPageOffset so a page larger than the enrich budget eventually completes', async () => {
    const pulls = Array.from({ length: 30 }, (_, i) =>
      pull({ number: i + 1, updated_at: new Date().toISOString() }),
    );
    client.listPullRequestsPage.mockResolvedValue({
      items: pulls,
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());

    // Second tick: the first one stopped at index 25 of this same page.
    const { envelopes } = await collector.poll(
      baseConnection({
        syncCursors: { prPage: 1, prPageOffset: 25 },
        config: {
          repoFullName: 'acme/payments',
          backfillSince: new Date(
            Date.now() - 90 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
      }),
    );

    // Only the 5 remaining items get enriched — not the 25 already done.
    expect(envelopes).toHaveLength(5);
    expect(client.getPullRequestDetail).toHaveBeenCalledTimes(5);
    expect(client.getPullRequestDetail).toHaveBeenNthCalledWith(
      1,
      'acme/payments',
      'tok',
      26,
    );
    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    // Page exhausted with no next page — backfill genuinely finishes.
    expect(cursors.prBackfillDone).toBe(true);
    expect(cursors.prPageOffset).toBeUndefined();
  });

  it('records why a pass failed on the connection, so zero events stops reading as healthy', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
      failed: true,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());

    await collector.poll(baseConnection());

    expect(connections.setSyncHealth).toHaveBeenCalledWith(
      'conn_1',
      expect.stringContaining('GitHub rejected'),
    );
  });

  it('clears the recorded failure on a clean pass so a connection recovers by itself', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());

    await collector.poll(baseConnection());

    expect(connections.setSyncHealth).toHaveBeenCalledWith('conn_1', null);
  });

  it('never concludes the PR backfill is complete when the page request fails', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
      failed: true,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());

    const connection = baseConnection({
      syncCursors: { prPage: 3, prPageOffset: 10 },
    });
    const { envelopes } = await collector.poll(connection);

    expect(envelopes).toEqual([]);
    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(cursors.prBackfillDone).toBeUndefined();
    expect(cursors.prPage).toBe(3);
    expect(cursors.prPageOffset).toBe(10);
    expect(connections.setBackfillCompletedAt).not.toHaveBeenCalled();
  });

  it('never advances the commit watermark when the commits request fails', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
      failed: true,
    });

    await collector.poll(baseConnection());

    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    // `commitsCursor` advancing here would permanently skip the un-walked history.
    expect(cursors.commitsCursor).toBeUndefined();
  });

  it('pins backfillSince onto config on the first poll, then reuses it instead of recomputing "now"', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());

    const before = Date.now();
    await collector.poll(baseConnection()); // config has no backfillSince
    const after = Date.now();

    expect(connections.updateConfig).toHaveBeenCalledWith('conn_1', {
      config: expect.objectContaining({ backfillSince: expect.any(String) }),
      status: 'active',
    });
    const call = connections.updateConfig.mock.calls[0][1] as {
      config: Record<string, unknown>;
    };
    const pinnedMs = new Date(call.config.backfillSince as string).getTime();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    expect(pinnedMs).toBeGreaterThanOrEqual(before - ninetyDaysMs - 1000);
    expect(pinnedMs).toBeLessThanOrEqual(after - ninetyDaysMs + 1000);

    jest.clearAllMocks();
    client.listPullRequestsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());
    secrets.resolve.mockResolvedValue('tok');

    await collector.poll(
      baseConnection({
        config: {
          repoFullName: 'acme/payments',
          backfillSince: '2026-01-01T00:00:00.000Z',
        },
      }),
    );

    // Already pinned — must not be overwritten with a freshly recomputed value.
    expect(connections.updateConfig).not.toHaveBeenCalled();
  });

  it('stops PR enrichment and persists resetAt when a PR-detail call is rate-limited during backfill', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [pull({ number: 1 }), pull({ number: 2 })],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());
    const resetAt = new Date(Date.now() + 60_000);
    client.getPullRequestDetail.mockResolvedValueOnce({
      additions: 10,
      deletions: 5,
      rateLimitedUntil: resetAt,
    });

    const { envelopes } = await collector.poll(baseConnection());

    expect(envelopes).toHaveLength(1);
    expect(client.getPullRequestDetail).toHaveBeenCalledTimes(1);
    expect(connections.setRateLimitState).toHaveBeenCalledWith('conn_1', {
      resetAt: resetAt.toISOString(),
    });
  });

  it("collects the PR's commit subjects, the third Jira-key source correlation matches on", async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [pull({ number: 1 })],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());
    client.listPullRequestCommits.mockResolvedValue({
      messages: ['PAY-2231 guard duplicate capture', 'fix typo'],
    });

    const { envelopes } = await collector.poll(baseConnection());

    expect(client.listPullRequestCommits).toHaveBeenCalledWith(
      'acme/payments',
      'tok',
      1,
    );
    // Neither the list endpoint, the detail call, nor the webhook payload
    // carries these — a PR keyed only in its commits is otherwise an orphan.
    expect(envelopes[0].data).toMatchObject({
      commitMessages: ['PAY-2231 guard duplicate capture', 'fix typo'],
    });
  });

  it('skips the commits call once the detail call reports a rate limit', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [pull({ number: 1 })],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());
    const resetAt = new Date(Date.now() + 60_000);
    client.getPullRequestDetail.mockResolvedValue({
      additions: 1,
      deletions: 1,
      rateLimitedUntil: resetAt,
    });

    await collector.poll(baseConnection());

    // It would only 403, and the tick is stopping anyway.
    expect(client.listPullRequestCommits).not.toHaveBeenCalled();
    expect(connections.setRateLimitState).toHaveBeenCalledWith('conn_1', {
      resetAt: resetAt.toISOString(),
    });
  });

  it('stops the tick when the commits call itself is rate-limited', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [pull({ number: 1 }), pull({ number: 2 })],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());
    const resetAt = new Date(Date.now() + 60_000);
    client.listPullRequestCommits.mockResolvedValueOnce({
      messages: [],
      rateLimitedUntil: resetAt,
    });

    const { envelopes } = await collector.poll(baseConnection());

    // The first PR is already enriched and emitted; the second waits.
    expect(envelopes).toHaveLength(1);
    expect(connections.setRateLimitState).toHaveBeenCalledWith('conn_1', {
      resetAt: resetAt.toISOString(),
    });
  });

  it('collects the review timeline and derives the FIRST review and FIRST approval', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [pull({ number: 1 })],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());
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
        // A later re-review must not push firstReviewAt forward: the sub-phase
        // measures how long the PR waited for its FIRST look.
        {
          externalId: '30',
          reviewerLogin: 'bjones',
          isBot: false,
          state: 'approved',
          submittedAt: '2026-06-05T08:00:00.000Z',
          hasBody: false,
        },
      ],
    });

    const { envelopes } = await collector.poll(baseConnection());

    expect(envelopes[0].data).toMatchObject({
      firstReviewAt: '2026-06-01T09:00:00.000Z',
      approvedAt: '2026-06-03T10:00:00.000Z',
    });
    expect((envelopes[0].data as { reviews: unknown[] }).reviews).toHaveLength(
      3,
    );
  });

  it('leaves reviews undefined when the reviews request failed, rather than reporting "unreviewed"', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [pull({ number: 1 })],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());
    client.listPullRequestReviews.mockResolvedValue({
      reviews: [],
      failed: true,
    });

    const { envelopes } = await collector.poll(baseConnection());

    // "Merged with no review" is a real finding (review_coverage,
    // self_merge_rate). Manufacturing it from a failed request would be worse
    // than reporting nothing — undefined leaves any stored timeline intact.
    const data = envelopes[0].data as {
      reviews?: unknown;
      firstReviewAt?: string;
    };
    expect(data.reviews).toBeUndefined();
    expect(data.firstReviewAt).toBeUndefined();
  });

  it('reports an empty review list as a real "no reviews" answer', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [pull({ number: 1 })],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());
    client.listPullRequestReviews.mockResolvedValue({ reviews: [] });

    const { envelopes } = await collector.poll(baseConnection());

    const data = envelopes[0].data as { reviews?: unknown[] };
    expect(data.reviews).toEqual([]);
  });

  it('stops the tick when the reviews call is rate-limited', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [pull({ number: 1 }), pull({ number: 2 })],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());
    const resetAt = new Date(Date.now() + 60_000);
    client.listPullRequestReviews.mockResolvedValueOnce({
      reviews: [],
      rateLimitedUntil: resetAt,
    });

    const { envelopes } = await collector.poll(baseConnection());

    expect(envelopes).toHaveLength(1);
    expect(connections.setRateLimitState).toHaveBeenCalledWith('conn_1', {
      resetAt: resetAt.toISOString(),
    });
  });

  it('incremental sync works oldest-first so a budget smaller than the backlog still converges', async () => {
    // 30 PRs, all newer than the existing watermark — exceeds the 25-per-tick budget.
    const pulls = Array.from({ length: 30 }, (_, i) =>
      pull({
        number: 100 - i,
        updated_at: new Date(
          Date.parse('2026-06-10T00:00:00.000Z') - i * 60_000,
        ).toISOString(),
      }),
    );
    client.listPullRequestsPage.mockResolvedValue({
      items: pulls,
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());
    const connection = baseConnection({
      syncCursors: {
        prBackfillDone: true,
        prNewestSeenAt: '2026-06-01T00:00:00.000Z',
      },
    });

    const { envelopes } = await collector.poll(connection);

    expect(envelopes).toHaveLength(25);
    expect(client.getPullRequestDetail).toHaveBeenCalledTimes(25);
    // The 25 OLDEST unsynced PRs (numbers 71–95), not the newest 25.
    expect(envelopes[0].externalRefs.pr_number).toBe('71');
    expect(envelopes[24].externalRefs.pr_number).toBe('95');

    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    // Advanced to the newest PR actually enriched — so next tick starts at the
    // 5 that were missed instead of redoing these 25. Working newest-first and
    // refusing to advance (the previous behaviour) meant the same 25 were
    // re-enriched every tick and the 5 oldest were never reached at all.
    expect(cursors.prNewestSeenAt).toBe('2026-06-09T23:55:00.000Z');
    // And never past the un-enriched remainder.
    expect(cursors.prNewestSeenAt).not.toBe('2026-06-10T00:00:00.000Z');
  });

  it('resumes a still-in-progress backfill from the saved page across ticks', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [pull({ number: 1 }), pull({ number: 2 })],
      hasNextPage: true,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());

    const connection = baseConnection({
      syncCursors: { prPage: 7, prNewestSeenAt: '2020-01-01T00:00:00.000Z' },
    });
    await collector.poll(connection);

    // page 7 was requested first (not restarted from 1), for all 3 budgeted fetches (7,8,9)
    expect(
      client.listPullRequestsPage.mock.calls.map((c) => c[2].page),
    ).toEqual([7, 8, 9]);
  });

  it('switches to incremental mode once backfill is done, stopping at the watermark', async () => {
    const watermark = '2026-06-01T00:00:00.000Z';
    const newer = pull({ number: 5, updated_at: '2026-06-02T00:00:00.000Z' });
    const same = pull({ number: 4, updated_at: watermark });
    client.listPullRequestsPage.mockResolvedValue({
      items: [newer, same],
      hasNextPage: true,
    });
    client.listCommitsPage.mockResolvedValue(emptyCommitsPage());

    const connection = baseConnection({
      syncCursors: { prBackfillDone: true, prNewestSeenAt: watermark },
    });
    const { envelopes } = await collector.poll(connection);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].collectionMode).toBe('poll');
    expect(client.listPullRequestsPage).toHaveBeenCalledTimes(1); // only page 1, ever
    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(cursors.prNewestSeenAt).toBe(newer.updated_at);
  });

  it('stops the whole tick and persists resetAt when PRs are rate-limited, skipping commits', async () => {
    const resetAt = new Date(Date.now() + 120_000);
    client.listPullRequestsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
      rateLimitedUntil: resetAt,
    });

    const { envelopes } = await collector.poll(baseConnection());

    expect(envelopes).toEqual([]);
    expect(client.listCommitsPage).not.toHaveBeenCalled();
    expect(connections.setRateLimitState).toHaveBeenCalledWith('conn_1', {
      resetAt: resetAt.toISOString(),
    });
  });

  it('backfills commits via the since-bounded endpoint and advances the cursor on completion', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue({
      items: [
        {
          sha: 'abc123',
          commit: {
            message: 'msg',
            author: {
              name: 'Jane',
              email: 'j@acme.com',
              date: '2026-06-01T00:00:00.000Z',
            },
            // rebased onto main a day later — committedAt should reflect that, not authoredAt
            committer: {
              name: 'Jane',
              email: 'j@acme.com',
              date: '2026-06-02T00:00:00.000Z',
            },
          },
          author: { login: 'jdoe' },
        },
      ],
      hasNextPage: false,
    });

    const { envelopes } = await collector.poll(baseConnection());

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].eventType).toBe('code.commit.pushed');
    expect(envelopes[0].idempotencyKey).toBe(
      'github:acme/payments:commit:abc123',
    );
    expect(client.getCommitDetail).toHaveBeenCalledWith(
      'acme/payments',
      'tok',
      'abc123',
    );
    expect(envelopes[0].data).toMatchObject({
      additions: 3,
      deletions: 1,
      authoredAt: '2026-06-01T00:00:00.000Z',
      committedAt: '2026-06-02T00:00:00.000Z',
    });
    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(cursors.commitsCursor).toBeDefined();
    expect(cursors.commitsResumePage).toBeUndefined();
  });

  it('defers un-enriched commits to a later tick once the enrichment budget runs out, instead of ingesting them with 0 stats', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
    });
    // 30 commits on one page — exceeds the 25-per-tick enrichment budget.
    const commits = Array.from({ length: 30 }, (_, i) => ({
      sha: `sha${i}`,
      commit: {
        message: 'msg',
        author: {
          name: 'Jane',
          email: 'j@acme.com',
          date: '2026-06-01T00:00:00.000Z',
        },
        committer: null,
      },
      author: { login: 'jdoe' },
    }));
    client.listCommitsPage.mockResolvedValue({
      items: commits,
      hasNextPage: false,
    });

    const { envelopes } = await collector.poll(baseConnection());

    expect(envelopes).toHaveLength(25);
    expect(client.getCommitDetail).toHaveBeenCalledTimes(25);
    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    // resumes the SAME page next tick — the 5 unenriched commits (and the 25
    // already-ingested ones, as harmless idempotent duplicates) get re-fetched.
    expect(cursors.commitsResumePage).toBe(1);
    expect(cursors.commitsCursor).toBeUndefined();
  });

  it('stops enriching and persists resetAt when a commit-detail call is rate-limited, resuming the same page', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue({
      items: [
        {
          sha: 'abc123',
          commit: {
            message: 'msg',
            author: {
              name: 'Jane',
              email: 'j@acme.com',
              date: '2026-06-01T00:00:00.000Z',
            },
            committer: null,
          },
          author: { login: 'jdoe' },
        },
        {
          sha: 'def456',
          commit: {
            message: 'msg2',
            author: {
              name: 'Jane',
              email: 'j@acme.com',
              date: '2026-06-02T00:00:00.000Z',
            },
            committer: null,
          },
          author: { login: 'jdoe' },
        },
      ],
      hasNextPage: false,
    });
    const resetAt = new Date(Date.now() + 60_000);
    client.getCommitDetail.mockResolvedValueOnce({
      additions: 3,
      deletions: 1,
      rateLimitedUntil: resetAt,
    });

    const { envelopes } = await collector.poll(baseConnection());

    // the first commit's already-fetched detail is kept; the second is never attempted
    expect(envelopes).toHaveLength(1);
    expect(client.getCommitDetail).toHaveBeenCalledTimes(1);
    expect(connections.setRateLimitState).toHaveBeenCalledWith('conn_1', {
      resetAt: resetAt.toISOString(),
    });
    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(cursors.commitsResumePage).toBe(1);
  });

  it('marks backfillCompletedAt exactly once — the tick both PRs and commits finish their historical backfill', async () => {
    // PRs already finished backfilling in a prior tick; commits finish THIS tick.
    client.listPullRequestsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
    });

    await collector.poll(
      baseConnection({
        syncCursors: { prBackfillDone: true },
        backfillCompletedAt: null,
      }),
    );

    expect(connections.setBackfillCompletedAt).toHaveBeenCalledWith('conn_1');
  });

  it('does not re-mark backfillCompletedAt on a genuine steady-state tick (already recorded)', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
    });

    await collector.poll(
      baseConnection({
        syncCursors: {
          prBackfillDone: true,
          commitsCursor: '2026-06-01T00:00:00.000Z',
        },
        backfillCompletedAt: new Date('2026-06-02T00:00:00.000Z'),
      }),
    );

    expect(connections.setBackfillCompletedAt).not.toHaveBeenCalled();
  });

  it('self-heals a connection whose cursors already show full backfill but whose backfillCompletedAt was never recorded (predates the tracking column)', async () => {
    client.listPullRequestsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
    });
    client.listCommitsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
    });

    await collector.poll(
      baseConnection({
        syncCursors: {
          prBackfillDone: true,
          commitsCursor: '2026-06-01T00:00:00.000Z',
        },
        backfillCompletedAt: null,
      }),
    );

    expect(connections.setBackfillCompletedAt).toHaveBeenCalledWith('conn_1');
  });
});

describe('GithubCollector.normalizeWebhook (push)', () => {
  const client = {
    searchIssues: jest.fn(),
  } as unknown as jest.Mocked<GithubClient>;
  const connections = {} as unknown as jest.Mocked<ConnectionsService>;
  const secrets = {} as unknown as jest.Mocked<SecretsService>;
  const collector = new GithubCollector(client, connections, secrets);

  it('sets committedAt equal to authoredAt — push payloads carry one timestamp per commit, not separate author/committer dates', async () => {
    const body = JSON.stringify({
      repository: { full_name: 'acme/payments' },
      commits: [
        {
          id: 'abc123',
          message: 'fix bug',
          timestamp: '2026-06-01T00:00:00.000Z',
          author: { name: 'Jane', email: 'j@acme.com', username: 'jdoe' },
          added: ['a.ts'],
          removed: [],
          modified: ['b.ts'],
        },
      ],
    });

    const envelopes = await collector.normalizeWebhook(
      baseConnection(),
      Buffer.from(body),
      { 'x-github-event': 'push' },
    );

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].data).toMatchObject({
      authoredAt: '2026-06-01T00:00:00.000Z',
      committedAt: '2026-06-01T00:00:00.000Z',
      filesChanged: 2,
    });
  });
});

/**
 * Switching `GITHUB_COLLECTION_MODE` changes how a walk paginates: REST resumes
 * on a page number, GraphQL on an opaque cursor, and neither can read the
 * other's. The collector must restart the walk rather than resume on a cursor
 * the live transport cannot interpret — and must never let that restart pass
 * for a completed backfill (ADR-0008).
 */
describe('GithubCollector.poll — collection mode changes', () => {
  let connections: jest.Mocked<ConnectionsService>;
  let secrets: jest.Mocked<SecretsService>;

  function clientFor(mode: 'rest' | 'graphql') {
    return {
      mode,
      listPullRequestsPage: jest.fn().mockResolvedValue({
        items: [],
        hasNextPage: false,
      } as GithubPage<GithubPull>),
      listCommitsPage: jest.fn().mockResolvedValue(emptyCommitsPage()),
      getCommitDetail: jest.fn().mockResolvedValue({}),
      getPullRequestDetail: jest.fn().mockResolvedValue({}),
      listPullRequestCommits: jest.fn().mockResolvedValue({ messages: [] }),
      listPullRequestReviews: jest.fn().mockResolvedValue({ reviews: [] }),
      listPullRequestReviewComments: jest
        .fn()
        .mockResolvedValue({ countByReviewId: new Map(), truncated: false }),
    } as unknown as jest.Mocked<GithubClient> & { mode: 'rest' | 'graphql' };
  }

  beforeEach(() => {
    connections = {
      setSyncCursors: jest.fn().mockResolvedValue(undefined),
      setRateLimitState: jest.fn().mockResolvedValue(undefined),
      setBackfillCompletedAt: jest.fn().mockResolvedValue(undefined),
      updateConfig: jest.fn().mockResolvedValue(undefined),
      setSyncHealth: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ConnectionsService>;
    secrets = {
      resolve: jest.fn().mockResolvedValue('tok'),
    } as unknown as jest.Mocked<SecretsService>;
  });

  it('restarts a REST-cursored backfill from page 1 when GraphQL takes over', async () => {
    const client = clientFor('graphql');
    const collector = new GithubCollector(client, connections, secrets);
    const connection = baseConnection({
      // Mid-backfill under REST: page 4, ten items in.
      syncCursors: { prPage: 4, prPageOffset: 10, cursorMode: 'rest' },
    });

    await collector.poll(connection);

    expect(client.listPullRequestsPage.mock.calls[0][2]).toEqual({
      page: 1,
      cursor: undefined,
    });
  });

  it('resumes normally when the persisted cursors match the live transport', async () => {
    const client = clientFor('graphql');
    const collector = new GithubCollector(client, connections, secrets);
    const connection = baseConnection({
      syncCursors: {
        prPage: 4,
        prGraphqlCursor: 'CUR3',
        cursorMode: 'graphql',
      },
    });

    await collector.poll(connection);

    expect(client.listPullRequestsPage.mock.calls[0][2]).toEqual({
      page: 4,
      cursor: 'CUR3',
    });
  });

  it('treats cursors with no recorded mode as REST, the only transport that wrote them before', async () => {
    const client = clientFor('rest');
    const collector = new GithubCollector(client, connections, secrets);
    const connection = baseConnection({
      // Written before cursorMode existed — must NOT be read as a mode switch.
      syncCursors: { prPage: 6 },
    });

    await collector.poll(connection);

    expect(client.listPullRequestsPage.mock.calls[0][2].page).toBe(6);
  });

  it('stamps the transport that wrote the cursors it just persisted', async () => {
    const client = clientFor('graphql');
    client.listPullRequestsPage.mockResolvedValue({
      items: [pull({ number: 1, updated_at: '2026-06-01T00:00:00.000Z' })],
      hasNextPage: true,
      endCursor: 'CUR9',
    } as GithubPage<GithubPull>);
    const collector = new GithubCollector(client, connections, secrets);

    await collector.poll(baseConnection({ syncCursors: {} }));

    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(cursors.cursorMode).toBe('graphql');
  });

  it('never reports a mode-switch restart as a completed backfill', async () => {
    // The one unacceptable outcome: a restart that looks like completion would
    // stamp backfillCompletedAt over history that was never re-walked.
    const client = clientFor('graphql');
    client.listPullRequestsPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
      failed: true,
    } as GithubPage<GithubPull>);
    const collector = new GithubCollector(client, connections, secrets);
    const connection = baseConnection({
      syncCursors: { prPage: 4, cursorMode: 'rest' },
    });

    const result = await collector.poll(connection);

    expect(result.failed).toBe(true);
    expect(connections.setBackfillCompletedAt).not.toHaveBeenCalled();
    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(cursors.prBackfillDone).toBeUndefined();
  });
});
