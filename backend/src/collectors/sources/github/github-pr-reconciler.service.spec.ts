import { Connection } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { GithubPrReconcilerService } from './github-pr-reconciler.service';
import { GithubClient } from './github.client';

function pr(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pr_1',
    tenantId: 'tenant-a',
    connectionId: 'conn_1',
    repoFullName: 'athmahealth/api',
    externalNumber: '42',
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    ...overrides,
  };
}

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn_1',
    tenantId: 'tenant-a',
    sourceSystem: 'github',
    secretRef: 'GITHUB_TOKEN',
    ...overrides,
  } as Connection;
}

describe('GithubPrReconcilerService', () => {
  let prisma: {
    pullRequest: { findMany: jest.Mock; update: jest.Mock; count: jest.Mock };
    connection: { findUnique: jest.Mock };
  };
  let secrets: jest.Mocked<SecretsService>;
  let client: jest.Mocked<GithubClient>;
  let service: GithubPrReconcilerService;

  beforeEach(() => {
    prisma = {
      pullRequest: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
        count: jest.fn().mockResolvedValue(0),
      },
      connection: { findUnique: jest.fn().mockResolvedValue(connection()) },
    };
    secrets = {
      resolve: jest.fn().mockResolvedValue('tok'),
    } as unknown as jest.Mocked<SecretsService>;
    client = {
      getPullRequestDetail: jest.fn(),
    } as unknown as jest.Mocked<GithubClient>;
    service = new GithubPrReconcilerService(
      prisma as unknown as PrismaService,
      secrets,
      client,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('updates each 0/0/0 PR with real stats fetched per-number', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([
      pr({ id: 'p1', externalNumber: '1' }),
      pr({ id: 'p2', externalNumber: '2' }),
    ]);
    client.getPullRequestDetail.mockResolvedValue({
      additions: 5,
      deletions: 2,
      changedFiles: 1,
    });

    const result = await service.reconcile('tenant-a');

    expect(result).toMatchObject({
      candidates: 2,
      updated: 2,
      skipped: 0,
      rateLimited: false,
      remaining: 0,
    });
    expect(prisma.pullRequest.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: {
        additions: 5,
        deletions: 2,
        changedFiles: 1,
        // Stamped so a scheduled sweep terminates instead of re-asking forever.
        detailFetchedAt: expect.any(Date),
      },
    });
    expect(client.getPullRequestDetail).toHaveBeenCalledWith(
      'athmahealth/api',
      'tok',
      '1',
    );
  });

  it('resolves the token once per connection, not once per PR', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([
      pr({ id: 'p1', externalNumber: '1' }),
      pr({ id: 'p2', externalNumber: '2' }),
    ]);
    client.getPullRequestDetail.mockResolvedValue({
      additions: 1,
      deletions: 1,
    });

    await service.reconcile('tenant-a');

    expect(secrets.resolve).toHaveBeenCalledTimes(1);
  });

  it('stops and reports rateLimited when GitHub signals a rate limit, leaving later PRs untouched', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([
      pr({ id: 'p1', externalNumber: '1' }),
      pr({ id: 'p2', externalNumber: '2' }),
    ]);
    const resetAt = new Date(Date.now() + 60_000);
    client.getPullRequestDetail.mockResolvedValueOnce({
      rateLimitedUntil: resetAt,
    });

    const result = await service.reconcile('tenant-a');

    expect(result).toMatchObject({ updated: 0, rateLimited: true });
    expect(prisma.pullRequest.update).not.toHaveBeenCalled();
    expect(client.getPullRequestDetail).toHaveBeenCalledTimes(1);
  });

  it('skips a PR whose connection no longer exists', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([pr({ id: 'p1' })]);
    prisma.connection.findUnique.mockResolvedValue(null);

    const result = await service.reconcile('tenant-a');

    expect(result).toMatchObject({ updated: 0, skipped: 1 });
    expect(client.getPullRequestDetail).not.toHaveBeenCalled();
  });

  it('skips a PR when no token is resolvable for its connection', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([pr({ id: 'p1' })]);
    secrets.resolve.mockResolvedValue('');

    const result = await service.reconcile('tenant-a');

    expect(result).toMatchObject({ updated: 0, skipped: 1 });
    expect(client.getPullRequestDetail).not.toHaveBeenCalled();
  });

  it('skips (without updating) when the detail call returns nothing at all', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([pr({ id: 'p1' })]);
    client.getPullRequestDetail.mockResolvedValue({});

    const result = await service.reconcile('tenant-a');

    expect(result).toMatchObject({ updated: 0, skipped: 1 });
    expect(prisma.pullRequest.update).not.toHaveBeenCalled();
  });

  it('queries for rows still at 0/0/0, and merged rows with no known merger', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([]);

    await service.reconcile('tenant-a');

    // `merged_by` lives only on this same detail response, so a PR backfilled
    // for reviews alone never got it — and self_merge_rate can't be computed
    // without it.
    expect(prisma.pullRequest.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        // Only rows never asked about. Without this a PR the source can never
        // satisfy — an empty diff, a merger whose account is gone — stays a
        // candidate forever, which a scheduled sweep would re-fetch every tick.
        detailFetchedAt: null,
        OR: [
          { additions: 0, deletions: 0, changedFiles: 0 },
          { state: 'merged', mergedBy: null },
        ],
      },
      take: 200,
    });
  });

  it('does not reset good stats on a PR selected only for its missing merger', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([
      {
        id: 'pr_1',
        connectionId: 'conn_1',
        repoFullName: 'acme/api',
        externalNumber: '1',
      },
    ]);
    client.getPullRequestDetail.mockResolvedValue({ mergedBy: 'asmith' });

    await service.reconcile('tenant-a');

    const data = prisma.pullRequest.update.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(data).toEqual({
      mergedBy: 'asmith',
      detailFetchedAt: expect.any(Date),
    });
    expect(data.additions).toBeUndefined();
  });
});
