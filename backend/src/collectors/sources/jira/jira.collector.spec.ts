import { Connection } from '@prisma/client';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { ConnectionsService } from '../../../modules/connections/connections.service';
import { JiraClient, JiraSearchIssue } from './jira.client';
import { JiraCollector } from './jira.collector';

function baseConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn_1',
    tenantId: 'tenant-a',
    sourceSystem: 'jira',
    name: 'acme jira',
    config: {
      siteUrl: 'https://acme.atlassian.net',
      email: 'admin@acme.com',
      projectKey: 'PAY',
    },
    secretRef: 'JIRA_API_TOKEN',
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

function issue(
  key: string,
  fields: Record<string, unknown> = {},
): JiraSearchIssue {
  return {
    key,
    fields: {
      summary: 't',
      status: { name: 'To Do' },
      project: { key: 'PAY' },
      updated: '2026-06-01T00:00:00.000Z',
      ...fields,
    },
  };
}

describe('JiraCollector.poll', () => {
  let client: jest.Mocked<JiraClient>;
  let connections: jest.Mocked<ConnectionsService>;
  let secrets: jest.Mocked<SecretsService>;
  let collector: JiraCollector;

  beforeEach(() => {
    client = { searchIssues: jest.fn() } as unknown as jest.Mocked<JiraClient>;
    connections = {
      setSyncCursors: jest.fn().mockResolvedValue(undefined),
      setRateLimitState: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ConnectionsService>;
    secrets = {
      resolve: jest.fn().mockResolvedValue('tok'),
    } as unknown as jest.Mocked<SecretsService>;
    collector = new JiraCollector(client, connections, secrets);
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
    expect(client.searchIssues).not.toHaveBeenCalled();
  });

  it('returns [] when siteUrl/email are missing from config', async () => {
    const result = await collector.poll(baseConnection({ config: {} }));
    expect(result).toEqual([]);
  });

  it('backfills all issues in one pass and advances the cursor to the last-seen updated time', async () => {
    client.searchIssues.mockResolvedValue({
      issues: [
        issue('PAY-1', { updated: '2026-06-01T00:00:00.000Z' }),
        issue('PAY-2', { updated: '2026-06-02T00:00:00.000Z' }),
      ],
      total: 2,
    });

    const envelopes = await collector.poll(baseConnection());

    expect(envelopes).toHaveLength(2);
    expect(envelopes.every((e) => e.collectionMode === 'backfill')).toBe(true);
    expect(envelopes[0].data).toMatchObject({
      externalKey: 'PAY-1',
      projectKey: 'PAY',
    });

    const [, cursors] = connections.setSyncCursors.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(cursors.updatedCursor).toBe('2026-06-02T00:00:00.000Z');
    expect(cursors.resumeStartAt).toBeUndefined();
  });

  it('resumes a paged backfill from resumeStartAt across ticks', async () => {
    client.searchIssues.mockResolvedValue({
      issues: [issue('PAY-1'), issue('PAY-2')],
      total: 500,
    });

    const connection = baseConnection({ syncCursors: { resumeStartAt: 100 } });
    await collector.poll(connection);

    expect(client.searchIssues.mock.calls[0][3]).toMatchObject({
      startAt: 100,
    });
    // 3 page-budget fetches: 100 -> 102 -> 104
    expect(client.searchIssues.mock.calls.map((c) => c[3].startAt)).toEqual([
      100, 102, 104,
    ]);
  });

  it('switches to incremental JQL floor once backfillDone (updatedCursor present)', async () => {
    client.searchIssues.mockResolvedValue({ issues: [], total: 0 });
    const connection = baseConnection({
      syncCursors: { updatedCursor: '2026-06-15T12:00:00.000Z' },
    });

    await collector.poll(connection);

    const jql = client.searchIssues.mock.calls[0][3].jql as string;
    expect(jql).toContain('2026/06/15');
    expect(jql).toContain('project = "PAY"');
  });

  it('stops and persists resetAt on a 429, preserving resumeStartAt', async () => {
    const resetAt = new Date(Date.now() + 30_000);
    client.searchIssues.mockResolvedValue({
      issues: [],
      total: 0,
      rateLimitedUntil: resetAt,
    });

    const envelopes = await collector.poll(
      baseConnection({ syncCursors: { resumeStartAt: 50 } }),
    );

    expect(envelopes).toEqual([]);
    expect(connections.setRateLimitState).toHaveBeenCalledWith('conn_1', {
      resetAt: resetAt.toISOString(),
    });
    const [, cursors] = connections.setSyncCursors.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(cursors.resumeStartAt).toBe(50);
  });

  it('maps subtask/epic hierarchy the same way normalizeWebhook does', async () => {
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_updated',
      issue: {
        key: 'PAY-9',
        fields: {
          summary: 'fix',
          status: { name: 'Done' },
          updated: '2026-06-01T00:00:00.000Z',
          project: { key: 'PAY' },
          issuetype: { name: 'Sub-task', subtask: true },
          parent: { key: 'PAY-8' },
        },
      },
    });

    const envelopes = await collector.normalizeWebhook(
      baseConnection(),
      Buffer.from(body),
      {},
    );

    expect(envelopes[0].data).toMatchObject({
      externalKey: 'PAY-9',
      parentKey: 'PAY-8',
      type: 'subtask',
    });
  });
});
