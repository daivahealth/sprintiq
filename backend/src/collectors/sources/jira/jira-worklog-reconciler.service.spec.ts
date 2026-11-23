import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import { JiraClient } from './jira.client';
import { JiraWorklogReconcilerService } from './jira-worklog-reconciler.service';

function story(externalKey: string, extra: Record<string, unknown> = {}) {
  return {
    id: `s_${externalKey}`,
    externalKey,
    projectKey: 'PAY',
    connectionId: 'conn_1',
    creatorLogin: null,
    creatorName: null,
    ...extra,
  };
}

describe('JiraWorklogReconcilerService', () => {
  let prisma: {
    story: { findMany: jest.Mock; update: jest.Mock; count: jest.Mock };
    connection: { findUnique: jest.Mock };
  };
  let client: jest.Mocked<JiraClient>;
  let ingestion: jest.Mocked<IngestionService>;
  let service: JiraWorklogReconcilerService;

  beforeEach(() => {
    prisma = {
      story: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      connection: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'conn_1',
          tenantId: 'tenant-a',
          config: {
            siteUrl: 'https://acme.atlassian.net',
            email: 'a@acme.com',
          },
          secretRef: 'JIRA_API_TOKEN',
        }),
      },
    };
    client = {
      searchIssues: jest.fn(),
      getIssueWorklogs: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<JiraClient>;
    ingestion = {
      ingest: jest
        .fn()
        .mockResolvedValue({ status: 'accepted', eventId: 'raw_1' }),
    } as unknown as jest.Mocked<IngestionService>;
    service = new JiraWorklogReconcilerService(
      prisma as unknown as PrismaService,
      {
        resolve: jest.fn().mockResolvedValue('tok'),
      } as unknown as SecretsService,
      client,
      ingestion,
    );
  });

  it('only considers never-collected rows of the calling tenant, newest first', async () => {
    await service.reconcile('tenant-a');
    expect(prisma.story.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-a', worklogsCollectedAt: null },
        orderBy: [{ sourceCreatedAt: { sort: 'desc', nulls: 'last' } }],
      }),
    );
  });

  it('sends worklogs through the ingestion pipeline and fills a missing creator directly', async () => {
    prisma.story.findMany.mockResolvedValue([story('PAY-1')]);
    client.searchIssues.mockResolvedValue({
      issues: [
        {
          key: 'PAY-1',
          fields: {
            creator: { accountId: 'acc-7', displayName: 'Asha Rao' },
            worklog: {
              total: 1,
              worklogs: [
                {
                  id: '501',
                  author: { accountId: 'acc-7' },
                  started: '2026-11-20T09:30:00.000+0530',
                  timeSpentSeconds: 1800,
                },
              ],
            },
          },
        },
      ],
    });

    const result = await service.reconcile('tenant-a');

    expect(client.searchIssues.mock.calls[0][3]).toMatchObject({
      jql: 'key in ("PAY-1")',
      fields: ['worklog', 'creator'],
    });
    expect(ingestion.ingest).toHaveBeenCalledWith(
      'tenant-a',
      expect.objectContaining({
        eventType: 'planning.issue.worklogs',
        collectionMode: 'backfill',
        idempotencyKey: expect.stringMatching(/^jira:worklogs:v1:PAY-1:/),
      }),
    );
    expect(prisma.story.update).toHaveBeenCalledWith({
      where: { id: 's_PAY-1' },
      data: { creatorLogin: 'acc-7', creatorName: 'Asha Rao' },
    });
    expect(result).toMatchObject({
      collected: 1,
      partial: 0,
      creatorsFilled: 1,
    });
  });

  it('never overwrites a creator already known', async () => {
    prisma.story.findMany.mockResolvedValue([
      story('PAY-1', { creatorLogin: 'acc-1', creatorName: 'Known' }),
    ]);
    client.searchIssues.mockResolvedValue({
      issues: [
        {
          key: 'PAY-1',
          fields: {
            creator: { accountId: 'acc-9' },
            worklog: { total: 0, worklogs: [] },
          },
        },
      ],
    });
    const result = await service.reconcile('tenant-a');
    expect(result.creatorsFilled).toBe(0);
    expect(prisma.story.update).not.toHaveBeenCalled();
  });

  it('stamps an issue Jira no longer returns, so the loop terminates', async () => {
    prisma.story.findMany.mockResolvedValue([story('PAY-404')]);
    client.searchIssues.mockResolvedValue({ issues: [] });
    const result = await service.reconcile('tenant-a');
    expect(prisma.story.update).toHaveBeenCalledWith({
      where: { id: 's_PAY-404' },
      data: { worklogsCollectedAt: expect.any(Date) },
    });
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(result.absent).toBe(1);
  });

  it('stamps a complete set already ingested by the poller, so it stops being re-fetched', async () => {
    prisma.story.findMany.mockResolvedValue([story('PAY-1')]);
    client.searchIssues.mockResolvedValue({
      issues: [
        { key: 'PAY-1', fields: { worklog: { total: 0, worklogs: [] } } },
      ],
    });
    ingestion.ingest.mockResolvedValue({
      status: 'duplicate',
      eventId: 'raw_0',
    });
    await service.reconcile('tenant-a');
    expect(prisma.story.update).toHaveBeenCalledWith({
      where: { id: 's_PAY-1' },
      data: { worklogsCollectedAt: expect.any(Date) },
    });
  });

  it('leaves a partial set as a candidate for the next run', async () => {
    prisma.story.findMany.mockResolvedValue([story('PAY-1')]);
    client.searchIssues.mockResolvedValue({
      issues: [
        {
          key: 'PAY-1',
          fields: {
            worklog: {
              total: 30,
              worklogs: [
                {
                  id: '1',
                  started: '2026-11-20T09:30:00.000+0530',
                  timeSpentSeconds: 60,
                },
              ],
            },
          },
        },
      ],
    });
    const result = await service.reconcile('tenant-a');
    expect(result.partial).toBe(1);
    expect(prisma.story.update).not.toHaveBeenCalled();
  });

  it('treats a rejected batch as unknown, never as "no worklogs"', async () => {
    prisma.story.findMany.mockResolvedValue([story('PAY-1')]);
    client.searchIssues.mockResolvedValue({ issues: [], failed: true });
    const result = await service.reconcile('tenant-a');
    expect(prisma.story.update).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('never uses another tenant’s connection, whatever the story row says', async () => {
    prisma.story.findMany.mockResolvedValue([story('PAY-1')]);
    prisma.connection.findUnique.mockResolvedValue({
      id: 'conn_1',
      tenantId: 'tenant-b',
      config: { siteUrl: 'https://other.atlassian.net', email: 'x@other.com' },
      secretRef: 'OTHER',
    });
    const result = await service.reconcile('tenant-a');
    expect(client.searchIssues).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});
