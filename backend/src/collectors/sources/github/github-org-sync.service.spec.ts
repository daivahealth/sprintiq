import { Connection } from '@prisma/client';
import { ConnectionsService } from '../../../modules/connections/connections.service';
import { GithubOrgSyncService } from './github-org-sync.service';
import { GithubClient, GithubPage, GithubRepo } from './github.client';

function repo(overrides: Partial<GithubRepo> = {}): GithubRepo {
  return {
    full_name: 'athmahealth/api',
    archived: false,
    disabled: false,
    ...overrides,
  };
}

describe('GithubOrgSyncService', () => {
  let client: jest.Mocked<GithubClient>;
  let connections: jest.Mocked<ConnectionsService>;
  let service: GithubOrgSyncService;

  beforeEach(() => {
    client = {
      listOrgReposPage: jest.fn(),
    } as unknown as jest.Mocked<GithubClient>;
    connections = {
      findByTenantSourceAndName: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'conn_new' } as Connection),
      updateConfig: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ConnectionsService>;
    service = new GithubOrgSyncService(client, connections);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates a connection per active repo, with a computed backfillSince', async () => {
    client.listOrgReposPage.mockResolvedValue({
      items: [
        repo({ full_name: 'athmahealth/api' }),
        repo({ full_name: 'athmahealth/web' }),
      ],
      hasNextPage: false,
    });

    const before = Date.now();
    const result = await service.syncOrgRepos(
      'tenant-a',
      'athmahealth',
      'GITHUB_TOKEN',
      'tok',
      7,
    );

    expect(result).toEqual({
      reposFound: 2,
      created: 2,
      updated: 0,
      skipped: 0,
      rateLimited: false,
    });
    expect(connections.create).toHaveBeenCalledTimes(2);
    const [, input] = connections.create.mock.calls[0];
    expect(input).toMatchObject({
      sourceSystem: 'github',
      name: 'athmahealth/api',
      secretRef: 'GITHUB_TOKEN',
    });
    const backfillSince = new Date(
      (input.config as { backfillSince: string }).backfillSince,
    ).getTime();
    expect(backfillSince).toBeLessThanOrEqual(before - 7 * 86_400_000 + 1000);
    expect(backfillSince).toBeGreaterThanOrEqual(
      before - 7 * 86_400_000 - 1000,
    );
  });

  it('skips archived and disabled repos', async () => {
    client.listOrgReposPage.mockResolvedValue({
      items: [
        repo({ full_name: 'athmahealth/old', archived: true }),
        repo({ full_name: 'athmahealth/gone', disabled: true }),
        repo({ full_name: 'athmahealth/active' }),
      ],
      hasNextPage: false,
    });

    const result = await service.syncOrgRepos(
      'tenant-a',
      'athmahealth',
      'GITHUB_TOKEN',
      'tok',
      7,
    );

    expect(result).toMatchObject({ reposFound: 3, created: 1, skipped: 2 });
    expect(connections.create).toHaveBeenCalledTimes(1);
  });

  it('updates (never duplicates or resets) a repo already registered by a prior sync', async () => {
    client.listOrgReposPage.mockResolvedValue({
      items: [repo({ full_name: 'athmahealth/api' })],
      hasNextPage: false,
    });
    connections.findByTenantSourceAndName.mockResolvedValue({
      id: 'conn_existing',
      config: {
        repoFullName: 'athmahealth/api',
        backfillSince: '2020-01-01T00:00:00.000Z',
      },
      webhookSecretRef: null,
    } as unknown as Connection);

    const result = await service.syncOrgRepos(
      'tenant-a',
      'athmahealth',
      'GITHUB_TOKEN',
      'tok',
      7,
    );

    expect(result).toMatchObject({ created: 0, updated: 1 });
    expect(connections.create).not.toHaveBeenCalled();
    expect(connections.updateConfig).toHaveBeenCalledWith(
      'conn_existing',
      expect.objectContaining({
        config: {
          repoFullName: 'athmahealth/api',
          backfillSince: '2020-01-01T00:00:00.000Z',
        },
        status: 'active',
      }),
    );
  });

  it('paginates across multiple pages until hasNextPage is false', async () => {
    client.listOrgReposPage
      .mockResolvedValueOnce({
        items: [repo({ full_name: 'athmahealth/a' })],
        hasNextPage: true,
      })
      .mockResolvedValueOnce({
        items: [repo({ full_name: 'athmahealth/b' })],
        hasNextPage: false,
      });

    const result = await service.syncOrgRepos(
      'tenant-a',
      'athmahealth',
      'GITHUB_TOKEN',
      'tok',
      7,
    );

    expect(result.reposFound).toBe(2);
    expect(client.listOrgReposPage.mock.calls.map((c) => c[2])).toEqual([1, 2]);
  });

  it('stops and reports rateLimited when GitHub signals a rate limit', async () => {
    const resetAt = new Date(Date.now() + 60_000);
    client.listOrgReposPage.mockResolvedValue({
      items: [],
      hasNextPage: false,
      rateLimitedUntil: resetAt,
    } as GithubPage<GithubRepo>);

    const result = await service.syncOrgRepos(
      'tenant-a',
      'athmahealth',
      'GITHUB_TOKEN',
      'tok',
      7,
    );

    expect(result.rateLimited).toBe(true);
    expect(connections.create).not.toHaveBeenCalled();
  });
});
