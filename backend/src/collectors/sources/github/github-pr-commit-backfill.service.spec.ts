import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import { GithubSourceClient } from './github-source-client';
import { GithubPrCommitBackfillService } from './github-pr-commit-backfill.service';

function pullRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pr_1',
    tenantId: 'tenant-a',
    connectionId: 'conn_1',
    repoFullName: 'acme/payments',
    externalNumber: '42',
    headSha: null,
    openedAt: new Date(),
    ...overrides,
  };
}

function commit(sha: string, overrides: Record<string, unknown> = {}) {
  return {
    sha,
    message: `msg ${sha}`,
    authorLogin: 'dev-a',
    authorName: 'Dev A',
    authorEmail: 'dev.a@example.com',
    authoredAt: '2026-09-01T10:00:00Z',
    committedAt: '2026-09-01T10:05:00Z',
    additions: 3,
    deletions: 1,
    filesChanged: 1,
    ...overrides,
  };
}

describe('GithubPrCommitBackfillService', () => {
  let prisma: {
    pullRequest: { findMany: jest.Mock; count: jest.Mock; update: jest.Mock };
    connection: { findUnique: jest.Mock };
    $queryRaw: jest.Mock;
  };
  let secrets: jest.Mocked<SecretsService>;
  let ingestion: jest.Mocked<IngestionService>;
  let client: jest.Mocked<GithubSourceClient>;
  let service: GithubPrCommitBackfillService;

  beforeEach(() => {
    prisma = {
      pullRequest: {
        findMany: jest.fn().mockResolvedValue([pullRow()]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue(undefined),
      },
      connection: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'conn_1', secretRef: 'GITHUB_TOKEN' }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ count: BigInt(0) }]),
    };
    secrets = {
      resolve: jest.fn().mockResolvedValue('tok'),
    } as unknown as jest.Mocked<SecretsService>;
    ingestion = {
      ingest: jest
        .fn()
        .mockResolvedValue({ status: 'accepted', eventId: 'e1' }),
    } as unknown as jest.Mocked<IngestionService>;
    client = {
      mode: 'graphql',
      listPullRequestCommits: jest.fn().mockResolvedValue({
        messages: ['msg a'],
        commits: [commit('aaa111')],
      }),
    } as unknown as jest.Mocked<GithubSourceClient>;

    service = new GithubPrCommitBackfillService(
      prisma as unknown as PrismaService,
      secrets,
      ingestion,
      client,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('ingests each PR commit through the pipeline under the canonical key, not by direct write', async () => {
    // These SHAs were never ingested, so unlike the sibling reconcilers there
    // is no burned idempotency key forcing a direct write — the recovered
    // history keeps the same lineage as everything else.
    const result = await service.reconcile('tenant-a');

    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
    const [tenantId, envelope] = ingestion.ingest.mock.calls[0];
    expect(tenantId).toBe('tenant-a');
    expect(envelope.idempotencyKey).toBe('github:acme/payments:commit:aaa111');
    expect(envelope.occurredAt).toBe('2026-09-01T10:00:00Z');
    expect(envelope.data).toMatchObject({
      sha: 'aaa111',
      authorLogin: 'dev-a',
      additions: 3,
    });
    expect(result.commitsIngested).toBe(1);
    expect(result.processed).toBe(1);
  });

  it('counts an already-collected commit as present rather than recovered', async () => {
    // A commit reachable from the default branch too. The key does its job
    // and the run must report what it actually recovered, not what it sent.
    ingestion.ingest.mockResolvedValue({
      status: 'duplicate',
      eventId: 'e1',
    });

    const result = await service.reconcile('tenant-a');

    expect(result.commitsIngested).toBe(0);
    expect(result.alreadyPresent).toBe(1);
    expect(result.processed).toBe(1);
  });

  it('fills the head sha from the last commit when the PR has none, and never overwrites one it has', async () => {
    client.listPullRequestCommits.mockResolvedValue({
      messages: [],
      commits: [commit('aaa111'), commit('bbb222')],
    });

    await service.reconcile('tenant-a');
    expect(prisma.pullRequest.update.mock.calls[0][0].data).toMatchObject({
      headSha: 'bbb222',
    });

    jest.clearAllMocks();
    prisma.pullRequest.findMany.mockResolvedValue([
      pullRow({ headSha: 'known-sha' }),
    ]);
    client.listPullRequestCommits.mockResolvedValue({
      messages: [],
      commits: [commit('aaa111')],
    });
    prisma.connection.findUnique.mockResolvedValue({
      id: 'conn_1',
      secretRef: 'GITHUB_TOKEN',
    });
    secrets.resolve.mockResolvedValue('tok');

    await service.reconcile('tenant-a');
    expect(
      prisma.pullRequest.update.mock.calls[0][0].data.headSha,
    ).toBeUndefined();
  });

  it('leaves a failed PR unstamped so it stays a candidate', async () => {
    // The §12 #6 lesson: a row retired without an answer is a permanent gap
    // that reports itself as complete.
    client.listPullRequestCommits.mockResolvedValue({
      messages: [],
      failed: true,
    });

    const result = await service.reconcile('tenant-a');

    expect(prisma.pullRequest.update).not.toHaveBeenCalled();
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('stops at a rate limit without stamping the PR it could not fetch', async () => {
    const resumeAt = new Date(Date.now() + 60_000);
    client.listPullRequestCommits.mockResolvedValue({
      messages: [],
      rateLimitedUntil: resumeAt,
    });

    const result = await service.reconcile('tenant-a');

    expect(result.rateLimited).toBe(true);
    expect(result.resumeAt).toBe(resumeAt);
    expect(prisma.pullRequest.update).not.toHaveBeenCalled();
  });

  it('stamps a PR whose commit list came back empty, so it is not re-asked forever', async () => {
    client.listPullRequestCommits.mockResolvedValue({
      messages: [],
      commits: [],
    });

    const result = await service.reconcile('tenant-a');

    expect(prisma.pullRequest.update).toHaveBeenCalled();
    expect(
      prisma.pullRequest.update.mock.calls[0][0].data.commitShasFetchedAt,
    ).toBeInstanceOf(Date);
    expect(result.processed).toBe(1);
  });

  it('drops a commit with no sha rather than minting an unkeyable envelope', async () => {
    client.listPullRequestCommits.mockResolvedValue({
      messages: [],
      commits: [commit(''), commit('ccc333')],
    });

    await service.reconcile('tenant-a');

    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
    expect(ingestion.ingest.mock.calls[0][1].idempotencyKey).toBe(
      'github:acme/payments:commit:ccc333',
    );
  });
});
