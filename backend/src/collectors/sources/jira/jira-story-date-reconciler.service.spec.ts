import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { JiraStoryDateReconcilerService } from './jira-story-date-reconciler.service';
import { JiraClient } from './jira.client';

function story(externalKey: string, connectionId = 'conn_1') {
  return { id: `s_${externalKey}`, externalKey, connectionId };
}

describe('JiraStoryDateReconcilerService', () => {
  let prisma: {
    story: { findMany: jest.Mock; update: jest.Mock };
    connection: { findUnique: jest.Mock };
  };
  let client: jest.Mocked<JiraClient>;
  let secrets: jest.Mocked<SecretsService>;
  let service: JiraStoryDateReconcilerService;

  beforeEach(() => {
    prisma = {
      story: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      connection: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'conn_1',
          config: {
            siteUrl: 'https://acme.atlassian.net',
            email: 'a@acme.com',
          },
          secretRef: 'JIRA_API_TOKEN',
        }),
      },
    };
    client = { searchIssues: jest.fn() } as unknown as jest.Mocked<JiraClient>;
    secrets = {
      resolve: jest.fn().mockResolvedValue('tok'),
    } as unknown as jest.Mocked<SecretsService>;
    service = new JiraStoryDateReconcilerService(
      prisma as unknown as PrismaService,
      secrets,
      client,
    );
  });

  it('only considers rows missing the date, scoped to the calling tenant', async () => {
    await service.reconcile('tenant-a');

    expect(prisma.story.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-a', sourceCreatedAt: null },
      }),
    );
  });

  it('fetches a whole batch in one request and writes each date back', async () => {
    prisma.story.findMany.mockResolvedValue([story('PAY-1'), story('PAY-2')]);
    client.searchIssues.mockResolvedValue({
      issues: [
        { key: 'PAY-1', fields: { created: '2026-01-04T09:30:00.000Z' } },
        { key: 'PAY-2', fields: { created: '2026-02-01T10:00:00.000Z' } },
      ],
    });

    const result = await service.reconcile('tenant-a');

    // One call for both issues — per-issue fetching would be ~13k requests on
    // a real tenant instead of ~130.
    expect(client.searchIssues).toHaveBeenCalledTimes(1);
    expect(client.searchIssues.mock.calls[0][3]).toMatchObject({
      jql: 'key in ("PAY-1","PAY-2")',
      fields: ['created'],
    });
    expect(prisma.story.update).toHaveBeenCalledWith({
      where: { id: 's_PAY-1' },
      data: { sourceCreatedAt: new Date('2026-01-04T09:30:00.000Z') },
    });
    expect(result).toMatchObject({ candidates: 2, updated: 2, skipped: 0 });
  });

  it('leaves an issue Jira no longer returns as null rather than guessing', async () => {
    prisma.story.findMany.mockResolvedValue([story('PAY-1'), story('GONE-9')]);
    client.searchIssues.mockResolvedValue({
      issues: [
        { key: 'PAY-1', fields: { created: '2026-01-04T09:30:00.000Z' } },
      ],
    });

    const result = await service.reconcile('tenant-a');

    // Deleted or moved out of view since collection. Staying null keeps it
    // excluded from lead time and counted — the honest state.
    expect(prisma.story.update).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ updated: 1, skipped: 1 });
  });

  it('stops on a rate limit instead of burning the remaining batches', async () => {
    prisma.story.findMany.mockResolvedValue([story('PAY-1')]);
    client.searchIssues.mockResolvedValue({
      issues: [],
      rateLimitedUntil: new Date(Date.now() + 60_000),
    });

    const result = await service.reconcile('tenant-a');

    expect(result.rateLimited).toBe(true);
    expect(prisma.story.update).not.toHaveBeenCalled();
  });

  it('a failed request leaves its rows as candidates for the next run', async () => {
    prisma.story.findMany.mockResolvedValue([story('PAY-1')]);
    client.searchIssues.mockResolvedValue({ issues: [], failed: true });

    const result = await service.reconcile('tenant-a');

    // Must never be read as "these issues have no created date" — that would
    // bake the gap in permanently, since the row stops being a candidate only
    // once it's actually filled.
    expect(prisma.story.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, skipped: 1 });
  });

  it('skips a connection whose credential no longer resolves, without touching its rows', async () => {
    prisma.story.findMany.mockResolvedValue([story('PAY-1'), story('PAY-2')]);
    secrets.resolve.mockResolvedValue('');

    const result = await service.reconcile('tenant-a');

    expect(client.searchIssues).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, skipped: 2 });
  });

  it('resolves each connection separately — a tenant can have several Jira sites', async () => {
    prisma.story.findMany.mockResolvedValue([
      story('PAY-1', 'conn_1'),
      story('OPS-1', 'conn_2'),
    ]);
    client.searchIssues.mockResolvedValue({
      issues: [
        { key: 'PAY-1', fields: { created: '2026-01-04T09:30:00.000Z' } },
      ],
    });

    await service.reconcile('tenant-a');

    expect(prisma.connection.findUnique).toHaveBeenCalledTimes(2);
    expect(client.searchIssues).toHaveBeenCalledTimes(2);
  });
});
