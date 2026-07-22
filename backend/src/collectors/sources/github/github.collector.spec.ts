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

function pull(overrides: Partial<GithubPull>): GithubPull {
  return {
    number: 1,
    title: 't',
    state: 'open',
    merged_at: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
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
      listPullRequestsPage: jest.fn(),
      listCommitsPage: jest.fn(),
    } as unknown as jest.Mocked<GithubClient>;
    connections = {
      setSyncCursors: jest.fn().mockResolvedValue(undefined),
      setRateLimitState: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ConnectionsService>;
    secrets = {
      resolve: jest.fn().mockResolvedValue('tok'),
    } as unknown as jest.Mocked<SecretsService>;
    collector = new GithubCollector(client, connections, secrets);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns [] without any API calls when still cooling down from a rate limit', async () => {
    const connection = baseConnection({
      rateLimitState: { resetAt: new Date(Date.now() + 60_000).toISOString() },
    });

    const result = await collector.poll(connection);

    expect(result).toEqual([]);
    expect(client.listPullRequestsPage).not.toHaveBeenCalled();
  });

  it('returns [] when no token resolves from secretRef', async () => {
    secrets.resolve.mockResolvedValue('');
    const result = await collector.poll(baseConnection());
    expect(result).toEqual([]);
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

    const envelopes = await collector.poll(baseConnection());

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].collectionMode).toBe('backfill');
    expect(envelopes[0].externalRefs.pr_number).toBe('1');

    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(cursors.prBackfillDone).toBe(true);
    expect(cursors.prPage).toBeUndefined();
    expect(cursors.prNewestSeenAt).toBe(within.updated_at);
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
    expect(client.listPullRequestsPage.mock.calls.map((c) => c[2])).toEqual([
      7, 8, 9,
    ]);
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
    const envelopes = await collector.poll(connection);

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

    const envelopes = await collector.poll(baseConnection());

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
          },
          author: { login: 'jdoe' },
        },
      ],
      hasNextPage: false,
    });

    const envelopes = await collector.poll(baseConnection());

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].eventType).toBe('code.commit.pushed');
    expect(envelopes[0].idempotencyKey).toBe(
      'github:acme/payments:commit:abc123',
    );
    const cursors = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(cursors.commitsCursor).toBeDefined();
    expect(cursors.commitsResumePage).toBeUndefined();
  });
});
