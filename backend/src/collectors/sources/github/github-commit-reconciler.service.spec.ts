import { Connection } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { GithubCommitReconcilerService } from './github-commit-reconciler.service';
import { GithubClient } from './github.client';

function commit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'commit_1',
    tenantId: 'tenant-a',
    connectionId: 'conn_1',
    repoFullName: 'athmahealth/api',
    sha: 'abc123',
    additions: 0,
    deletions: 0,
    filesChanged: 0,
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

describe('GithubCommitReconcilerService', () => {
  let prisma: {
    commit: { findMany: jest.Mock; update: jest.Mock };
    connection: { findUnique: jest.Mock };
  };
  let secrets: jest.Mocked<SecretsService>;
  let client: jest.Mocked<GithubClient>;
  let service: GithubCommitReconcilerService;

  beforeEach(() => {
    prisma = {
      commit: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
      connection: { findUnique: jest.fn().mockResolvedValue(connection()) },
    };
    secrets = {
      resolve: jest.fn().mockResolvedValue('tok'),
    } as unknown as jest.Mocked<SecretsService>;
    client = {
      getCommitDetail: jest.fn(),
    } as unknown as jest.Mocked<GithubClient>;
    service = new GithubCommitReconcilerService(
      prisma as unknown as PrismaService,
      secrets,
      client,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('updates each 0/0/0 commit with real stats fetched per-sha', async () => {
    prisma.commit.findMany.mockResolvedValue([
      commit({ id: 'c1', sha: 'sha1' }),
      commit({ id: 'c2', sha: 'sha2' }),
    ]);
    client.getCommitDetail.mockResolvedValue({
      additions: 5,
      deletions: 2,
      filesChanged: 1,
    });

    const result = await service.reconcile('tenant-a');

    expect(result).toEqual({
      candidates: 2,
      updated: 2,
      skipped: 0,
      rateLimited: false,
    });
    expect(prisma.commit.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { additions: 5, deletions: 2, filesChanged: 1 },
    });
    expect(client.getCommitDetail).toHaveBeenCalledWith(
      'athmahealth/api',
      'tok',
      'sha1',
    );
  });

  it('resolves the token once per connection, not once per commit', async () => {
    prisma.commit.findMany.mockResolvedValue([
      commit({ id: 'c1', sha: 'sha1' }),
      commit({ id: 'c2', sha: 'sha2' }),
    ]);
    client.getCommitDetail.mockResolvedValue({ additions: 1, deletions: 1 });

    await service.reconcile('tenant-a');

    expect(secrets.resolve).toHaveBeenCalledTimes(1);
  });

  it('stops and reports rateLimited when GitHub signals a rate limit, leaving later commits untouched', async () => {
    prisma.commit.findMany.mockResolvedValue([
      commit({ id: 'c1', sha: 'sha1' }),
      commit({ id: 'c2', sha: 'sha2' }),
    ]);
    const resetAt = new Date(Date.now() + 60_000);
    client.getCommitDetail.mockResolvedValueOnce({ rateLimitedUntil: resetAt });

    const result = await service.reconcile('tenant-a');

    expect(result).toMatchObject({ updated: 0, rateLimited: true });
    expect(prisma.commit.update).not.toHaveBeenCalled();
    expect(client.getCommitDetail).toHaveBeenCalledTimes(1);
  });

  it('skips a commit whose connection no longer exists', async () => {
    prisma.commit.findMany.mockResolvedValue([commit({ id: 'c1' })]);
    prisma.connection.findUnique.mockResolvedValue(null);

    const result = await service.reconcile('tenant-a');

    expect(result).toMatchObject({ updated: 0, skipped: 1 });
    expect(client.getCommitDetail).not.toHaveBeenCalled();
  });

  it('skips a commit when no token is resolvable for its connection', async () => {
    prisma.commit.findMany.mockResolvedValue([commit({ id: 'c1' })]);
    secrets.resolve.mockResolvedValue('');

    const result = await service.reconcile('tenant-a');

    expect(result).toMatchObject({ updated: 0, skipped: 1 });
    expect(client.getCommitDetail).not.toHaveBeenCalled();
  });

  it('skips (without updating) when the detail call returns nothing at all', async () => {
    prisma.commit.findMany.mockResolvedValue([commit({ id: 'c1' })]);
    client.getCommitDetail.mockResolvedValue({});

    const result = await service.reconcile('tenant-a');

    expect(result).toMatchObject({ updated: 0, skipped: 1 });
    expect(prisma.commit.update).not.toHaveBeenCalled();
  });

  it('backfills committedAt for an already-enriched commit (real stats, missing committedAt) without touching its stats', async () => {
    prisma.commit.findMany.mockResolvedValue([
      commit({
        id: 'c1',
        additions: 5,
        deletions: 2,
        filesChanged: 3,
        committedAt: null,
      }),
    ]);
    client.getCommitDetail.mockResolvedValue({
      additions: 5,
      deletions: 2,
      filesChanged: 3,
      committedAt: '2026-06-02T00:00:00.000Z',
    });

    const result = await service.reconcile('tenant-a');

    expect(result).toMatchObject({ updated: 1, skipped: 0 });
    expect(prisma.commit.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: {
        additions: 5,
        deletions: 2,
        filesChanged: 3,
        committedAt: new Date('2026-06-02T00:00:00.000Z'),
      },
    });
  });

  it('queries for rows missing either stats or committedAt', async () => {
    prisma.commit.findMany.mockResolvedValue([]);

    await service.reconcile('tenant-a');

    expect(prisma.commit.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        OR: [
          { additions: 0, deletions: 0, filesChanged: 0 },
          { committedAt: null },
        ],
      },
      take: 200,
    });
  });
});

describe('GithubCommitReconcilerService.reconcileParentCounts', () => {
  let prisma: {
    commit: { findMany: jest.Mock; updateMany: jest.Mock };
    connection: { findUnique: jest.Mock };
  };
  let client: { getCommitParentCounts: jest.Mock };
  let service: GithubCommitReconcilerService;

  const row = (id: string, sha: string, repoFullName = 'athmahealth/api') => ({
    id,
    sha,
    repoFullName,
    connectionId: 'conn_1',
  });

  beforeEach(() => {
    prisma = {
      commit: {
        findMany: jest.fn(),
        updateMany: jest
          .fn()
          .mockImplementation(
            ({ where }: { where: { id: { in: string[] } } }) =>
              Promise.resolve({ count: where.id.in.length }),
          ),
      },
      connection: {
        findUnique: jest.fn().mockResolvedValue({ secretRef: 'GITHUB_TOKEN' }),
      },
    };
    client = { getCommitParentCounts: jest.fn() };
    service = new GithubCommitReconcilerService(
      prisma as unknown as PrismaService,
      {
        resolve: jest.fn().mockResolvedValue('tok'),
      } as unknown as SecretsService,
      client as unknown as GithubClient,
    );
  });

  it('writes each commit its parent count, grouped by value, and reports done', async () => {
    prisma.commit.findMany.mockResolvedValue([
      row('c1', 'a'),
      row('c2', 'b'),
      row('c3', 'c'),
    ]);
    client.getCommitParentCounts.mockResolvedValue({
      counts: new Map([
        ['a', 1],
        ['b', 2],
        ['c', 1],
      ]),
    });

    const result = await service.reconcileParentCounts('tenant-a');

    expect(client.getCommitParentCounts).toHaveBeenCalledTimes(1);
    expect(prisma.commit.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', id: { in: ['c1', 'c3'] } },
      data: { parentCount: 1 },
    });
    expect(prisma.commit.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', id: { in: ['c2'] } },
      data: { parentCount: 2 },
    });
    expect(result).toMatchObject({
      updated: 3,
      unanswered: 0,
      done: true,
      nextCursor: null,
    });
  });

  it('leaves a commit GitHub does not answer for null, and moves the cursor past it', async () => {
    // Without the cursor, an unanswerable row would head every later run's
    // `parentCount: null` selection forever.
    prisma.commit.findMany.mockResolvedValue([
      row('c1', 'a'),
      row('c2', 'gone'),
    ]);
    client.getCommitParentCounts.mockResolvedValue({
      counts: new Map([['a', 1]]),
    });

    const result = await service.reconcileParentCounts(
      'tenant-a',
      undefined,
      2,
    );

    expect(result).toMatchObject({
      updated: 1,
      unanswered: 1,
      done: false,
      nextCursor: 'c2',
    });
  });

  it('stops on a rate limit and resumes from the cursor it was given', async () => {
    prisma.commit.findMany.mockResolvedValue([row('c5', 'a')]);
    client.getCommitParentCounts.mockResolvedValue({
      counts: new Map(),
      rateLimitedUntil: new Date('2026-10-15T12:00:00Z'),
    });

    const result = await service.reconcileParentCounts('tenant-a', 'c4');

    expect(prisma.commit.updateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      rateLimited: true,
      done: false,
      nextCursor: 'c4',
    });
  });

  it('batches per repo, never mixing two repos in one source call', async () => {
    prisma.commit.findMany.mockResolvedValue([
      row('c1', 'a', 'athmahealth/api'),
      row('c2', 'b', 'athmahealth/web'),
    ]);
    client.getCommitParentCounts.mockResolvedValue({ counts: new Map() });

    await service.reconcileParentCounts('tenant-a');

    expect(
      client.getCommitParentCounts.mock.calls.map((c) => [c[0], c[2]]),
    ).toEqual([
      ['athmahealth/api', ['a']],
      ['athmahealth/web', ['b']],
    ]);
  });
});
