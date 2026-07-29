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
