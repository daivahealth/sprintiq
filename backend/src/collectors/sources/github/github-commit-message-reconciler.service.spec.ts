import { Connection } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { GithubCommitMessageReconcilerService } from './github-commit-message-reconciler.service';
import { GithubClient } from './github.client';

function pr(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pr_1',
    tenantId: 'tenant-a',
    connectionId: 'conn_1',
    repoFullName: 'athmahealth/api',
    externalNumber: '42',
    commitMessages: [] as string[],
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

describe('GithubCommitMessageReconcilerService', () => {
  let prisma: {
    pullRequest: { findMany: jest.Mock; update: jest.Mock; count: jest.Mock };
    connection: { findUnique: jest.Mock };
  };
  let secrets: jest.Mocked<SecretsService>;
  let client: jest.Mocked<GithubClient>;
  let service: GithubCommitMessageReconcilerService;

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
      listPullRequestCommits: jest.fn(),
    } as unknown as jest.Mocked<GithubClient>;
    service = new GithubCommitMessageReconcilerService(
      prisma as unknown as PrismaService,
      secrets,
      client,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('writes fetched commit messages and stamps each PR as asked', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([
      pr({ id: 'p1', externalNumber: '1' }),
      pr({ id: 'p2', externalNumber: '2' }),
    ]);
    client.listPullRequestCommits.mockResolvedValue({
      messages: ['PAY-2231 guard duplicate capture', 'fix typo'],
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
        commitMessages: ['PAY-2231 guard duplicate capture', 'fix typo'],
        // Stamped so a scheduled sweep terminates instead of re-asking forever.
        commitsFetchedAt: expect.any(Date),
      },
    });
    expect(client.listPullRequestCommits).toHaveBeenCalledWith(
      'athmahealth/api',
      'tok',
      '1',
    );
  });

  it('queries only never-asked PRs with no stored messages, newest first', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([]);

    await service.reconcile('tenant-a');

    expect(prisma.pullRequest.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        // Only rows never asked about — a PR from a since-deleted repo can
        // never be answered, and without the stamp filter a scheduled sweep
        // would re-fetch it every tick forever.
        commitsFetchedAt: null,
        // PRs enriched by the live collector already carry their messages —
        // re-fetching them recovers nothing.
        commitMessages: { isEmpty: true },
      },
      // Newest first: recent PRs are the ones dashboards actually window on.
      orderBy: { openedAt: 'desc' },
      take: 500,
    });
  });

  it('stamps a PR whose fetch succeeded with zero messages — asked and answered', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([pr({ id: 'p1' })]);
    client.listPullRequestCommits.mockResolvedValue({ messages: [] });

    const result = await service.reconcile('tenant-a');

    // "Genuinely no messages" is an answer; leaving the row a candidate would
    // re-fetch it every tick. The stored (empty) messages are left untouched.
    expect(result).toMatchObject({ updated: 1, skipped: 0 });
    expect(prisma.pullRequest.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { commitsFetchedAt: expect.any(Date) },
    });
  });

  it('skips (without stamping) when the fetch failed — an unanswered PR stays a candidate', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([pr({ id: 'p1' })]);
    client.listPullRequestCommits.mockResolvedValue({
      messages: [],
      failed: true,
    });

    const result = await service.reconcile('tenant-a');

    expect(result).toMatchObject({ updated: 0, skipped: 1 });
    expect(prisma.pullRequest.update).not.toHaveBeenCalled();
  });

  it('stops and reports rateLimited on a hard limit, leaving later PRs untouched', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([
      pr({ id: 'p1', externalNumber: '1' }),
      pr({ id: 'p2', externalNumber: '2' }),
    ]);
    const resetAt = new Date(Date.now() + 60_000);
    client.listPullRequestCommits.mockResolvedValueOnce({
      messages: [],
      rateLimitedUntil: resetAt,
    });

    const result = await service.reconcile('tenant-a');

    expect(result).toMatchObject({
      updated: 0,
      rateLimited: true,
      resumeAt: resetAt,
    });
    expect(prisma.pullRequest.update).not.toHaveBeenCalled();
    expect(client.listPullRequestCommits).toHaveBeenCalledTimes(1);
  });

  it('stops at the rate reserve rather than draining quota the poller needs', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([
      pr({ id: 'p1', externalNumber: '1' }),
      pr({ id: 'p2', externalNumber: '2' }),
    ]);
    const resetAt = new Date(Date.now() + 60_000);
    client.listPullRequestCommits.mockResolvedValue({
      messages: ['PAY-1 fix'],
      rateLimit: { remaining: 999, resetAt }, // below the default 1000 reserve
    });

    const result = await service.reconcile('tenant-a');

    // The PR that spent the quota is still written — stopping applies to the
    // NEXT call, not to work already paid for.
    expect(result).toMatchObject({
      updated: 1,
      rateLimited: true,
      resumeAt: resetAt,
    });
    expect(client.listPullRequestCommits).toHaveBeenCalledTimes(1);
  });

  it('resolves the token once per connection, not once per PR', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([
      pr({ id: 'p1', externalNumber: '1' }),
      pr({ id: 'p2', externalNumber: '2' }),
    ]);
    client.listPullRequestCommits.mockResolvedValue({ messages: ['m'] });

    await service.reconcile('tenant-a');

    expect(secrets.resolve).toHaveBeenCalledTimes(1);
  });

  it('skips a PR whose connection no longer exists, and one with no resolvable token', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([
      pr({ id: 'p1', connectionId: 'conn_gone' }),
      pr({ id: 'p2', connectionId: 'conn_1' }),
    ]);
    prisma.connection.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === 'conn_1' ? connection() : null),
    );
    secrets.resolve.mockResolvedValue('');

    const result = await service.reconcile('tenant-a');

    expect(result).toMatchObject({ updated: 0, skipped: 2 });
    expect(client.listPullRequestCommits).not.toHaveBeenCalled();
  });
});
