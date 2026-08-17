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
      // Pre-resolved as "no such field" by default so existing tests don't
      // need to stub `client.getFields` — see the dedicated resolution tests.
      sprintFieldId: null,
      storyPointsFieldIds: [],
      statusCategories: {},
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
    client = {
      searchIssues: jest.fn(),
      getFields: jest.fn().mockResolvedValue([]),
      getIssueChangelog: jest.fn().mockResolvedValue(null),
      getStatusCategories: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<JiraClient>;
    connections = {
      setSyncCursors: jest.fn().mockResolvedValue(undefined),
      setRateLimitState: jest.fn().mockResolvedValue(undefined),
      updateConfig: jest.fn().mockResolvedValue(undefined),
      setBackfillCompletedAt: jest.fn().mockResolvedValue(undefined),
      setSyncHealth: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ConnectionsService>;
    secrets = {
      resolve: jest.fn().mockResolvedValue('tok'),
    } as unknown as jest.Mocked<SecretsService>;
    collector = new JiraCollector(client, connections, secrets);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('reports a rate-limit cooldown as skipped, not as an empty success', async () => {
    // The distinction is what stops the scheduler stamping lastSyncAt on a
    // connection this pass never called Jira for.
    const connection = baseConnection({
      rateLimitState: { resetAt: new Date(Date.now() + 60_000).toISOString() },
    });
    const result = await collector.poll(connection);
    expect(result).toEqual({ envelopes: [], skipped: 'rate-limited' });
    expect(client.searchIssues).not.toHaveBeenCalled();
  });

  it('reports coverage back to the floor and through the last issue seen, even mid-pass', async () => {
    // Jira walks ASCENDING from the floor, so everything between the floor and
    // wherever it has paged to is genuinely collected — reportable now. The
    // resume cursor (`updatedCursor`) still may not move until the pass
    // completes, because it keys the page token; the reported watermark is a
    // separate value precisely so honesty here does not break resumption.
    client.searchIssues.mockResolvedValue({
      issues: [
        issue('PAY-1', { updated: '2026-06-01T00:00:00.000Z' }),
        issue('PAY-2', { updated: '2026-06-02T00:00:00.000Z' }),
      ],
      nextPageToken: 'more',
    });
    const floor = '2025-08-17T00:00:00.000Z';

    const result = await collector.poll(
      baseConnection({
        config: {
          siteUrl: 'https://acme.atlassian.net',
          email: 'admin@acme.com',
          sprintFieldId: null,
          storyPointsFieldIds: [],
          statusCategories: {},
          backfillSince: floor,
        },
      }),
    );

    expect(result.collectedBackTo).toEqual(new Date(floor));
    expect(result.collectedThroughAt).toEqual(
      new Date('2026-06-02T00:00:00.000Z'),
    );
  });

  it('reports missing siteUrl/email as skipped, not as an empty success', async () => {
    const result = await collector.poll(baseConnection({ config: {} }));
    expect(result).toEqual({ envelopes: [], skipped: 'not-configured' });
  });

  it('backfills all issues in one pass and advances the cursor to the last-seen updated time', async () => {
    client.searchIssues.mockResolvedValue({
      issues: [
        issue('PAY-1', { updated: '2026-06-01T00:00:00.000Z' }),
        issue('PAY-2', { updated: '2026-06-02T00:00:00.000Z' }),
      ],
    });

    const { envelopes } = await collector.poll(baseConnection());

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
    expect(cursors.resumePageToken).toBeUndefined();
  });

  it('resumes a paged backfill from resumePageToken across ticks', async () => {
    client.searchIssues.mockResolvedValue({
      issues: [issue('PAY-1'), issue('PAY-2')],
      nextPageToken: 'tok_next',
    });

    const connection = baseConnection({
      syncCursors: { resumePageToken: 'tok_100' },
    });
    await collector.poll(connection);

    expect(client.searchIssues.mock.calls[0][3]).toMatchObject({
      pageToken: 'tok_100',
    });
    // Keeps paging within the tick, each fetch continuing from the previous
    // response's nextPageToken. Asserted against the shape rather than a fixed
    // count so tuning PAGE_BUDGET_PER_TICK doesn't break this test.
    const tokens = client.searchIssues.mock.calls.map((c) => c[3].pageToken);
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens[0]).toBe('tok_100');
    expect(tokens.slice(1).every((t) => t === 'tok_next')).toBe(true);

    const [, cursors] = connections.setSyncCursors.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    // budget exhausted mid-pass — resumes from the last token next tick
    expect(cursors.resumePageToken).toBe('tok_next');
  });

  it('pins backfillSince onto connection.config on the first poll of a backfill pass, then reuses the pinned value instead of recomputing "now" on later polls', async () => {
    client.searchIssues.mockResolvedValue({ issues: [] });

    const before = Date.now();
    await collector.poll(baseConnection()); // default config has no backfillSince yet
    const after = Date.now();

    expect(connections.updateConfig).toHaveBeenCalledWith('conn_1', {
      config: expect.objectContaining({ backfillSince: expect.any(String) }),
      status: 'active',
    });
    // `resolveCustomFieldIds` may also have written config this tick — pick the
    // call that actually carries the pinned floor.
    const pinnedCall = connections.updateConfig.mock.calls
      .map(([, arg]) => arg as { config: Record<string, unknown> })
      .find((arg) => arg.config.backfillSince !== undefined);
    const pinnedIso = pinnedCall?.config.backfillSince as string;
    const pinnedMs = new Date(pinnedIso).getTime();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    expect(pinnedMs).toBeGreaterThanOrEqual(before - ninetyDaysMs - 1000);
    expect(pinnedMs).toBeLessThanOrEqual(after - ninetyDaysMs + 1000);

    jest.clearAllMocks();
    client.searchIssues.mockResolvedValue({ issues: [] });
    secrets.resolve.mockResolvedValue('tok');

    // Second poll — simulating the pinned value now being persisted on the connection.
    await collector.poll(
      baseConnection({
        config: {
          siteUrl: 'https://acme.atlassian.net',
          email: 'admin@acme.com',
          sprintFieldId: null,
          storyPointsFieldIds: [],
          statusCategories: {},
          backfillSince: pinnedIso,
        },
      }),
    );

    const pinnedDate = new Date(pinnedIso);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expectedDatePart = `${pinnedDate.getFullYear()}/${pad(pinnedDate.getMonth() + 1)}/${pad(pinnedDate.getDate())}`;
    const jql = client.searchIssues.mock.calls[0][3].jql as string;
    expect(jql).toContain(expectedDatePart);
    // Already pinned — must not overwrite it with a freshly recomputed value.
    // Asserted on the floor specifically, since other per-site caches
    // (custom fields, status categories) legitimately write config too.
    const rewrotefloor = connections.updateConfig.mock.calls.some(
      ([, arg]) =>
        (arg as { config: Record<string, unknown> }).config.backfillSince !==
        pinnedIso,
    );
    expect(rewrotefloor).toBe(false);
  });

  it('records why a pass failed on the connection, so zero events stops reading as healthy', async () => {
    client.searchIssues.mockResolvedValueOnce({ issues: [], failed: true });

    await collector.poll(baseConnection());

    expect(connections.setSyncHealth).toHaveBeenCalledWith(
      'conn_1',
      expect.stringContaining('Jira rejected'),
    );
  });

  it('records a missing credential rather than returning silently', async () => {
    secrets.resolve.mockResolvedValue('');

    const { envelopes } = await collector.poll(baseConnection());

    expect(envelopes).toEqual([]);
    expect(connections.setSyncHealth).toHaveBeenCalledWith(
      'conn_1',
      expect.stringContaining('No credential resolved'),
    );
  });

  it('clears the recorded failure on a clean pass so a connection recovers by itself', async () => {
    client.searchIssues.mockResolvedValue({ issues: [] });

    await collector.poll(baseConnection());

    expect(connections.setSyncHealth).toHaveBeenCalledWith('conn_1', null);
  });

  it('does not conclude the backfill is complete when a resumed page request fails (vs. genuinely running out of pages)', async () => {
    client.searchIssues.mockResolvedValueOnce({ issues: [], failed: true });

    const connection = baseConnection({
      syncCursors: { resumePageToken: 'tok_stale' },
    });
    const { envelopes } = await collector.poll(connection);

    expect(envelopes).toEqual([]);
    expect(connections.setBackfillCompletedAt).not.toHaveBeenCalled();
    const [, cursors] = connections.setSyncCursors.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    // Retries the SAME token next tick — never silently advances or "completes".
    expect(cursors.resumePageToken).toBe('tok_stale');
    expect(cursors.updatedCursor).toBeUndefined();
  });

  it('switches to incremental JQL floor once backfillDone (updatedCursor present)', async () => {
    client.searchIssues.mockResolvedValue({ issues: [] });
    const connection = baseConnection({
      syncCursors: { updatedCursor: '2026-06-15T12:00:00.000Z' },
    });

    await collector.poll(connection);

    const jql = client.searchIssues.mock.calls[0][3].jql as string;
    expect(jql).toContain('2026/06/15');
    expect(jql).toContain('project = "PAY"');
  });

  it('stops and persists resetAt on a 429, preserving resumePageToken', async () => {
    const resetAt = new Date(Date.now() + 30_000);
    client.searchIssues.mockResolvedValue({
      issues: [],
      rateLimitedUntil: resetAt,
    });

    const { envelopes } = await collector.poll(
      baseConnection({ syncCursors: { resumePageToken: 'tok_50' } }),
    );

    expect(envelopes).toEqual([]);
    expect(connections.setRateLimitState).toHaveBeenCalledWith('conn_1', {
      resetAt: resetAt.toISOString(),
    });
    const [, cursors] = connections.setSyncCursors.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(cursors.resumePageToken).toBe('tok_50');
  });

  it('resolves the site-specific Sprint custom-field id once and caches it on the connection', async () => {
    client.getFields.mockResolvedValue([
      { id: 'summary', name: 'Summary' },
      {
        id: 'customfield_10020',
        name: 'Sprint',
        schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' },
      },
    ]);
    client.searchIssues.mockResolvedValue({
      issues: [
        issue('PAY-1', {
          customfield_10020: [
            { id: 5, name: 'Sprint 5', state: 'active', goal: 'ship it' },
          ],
        }),
      ],
    });

    const connection = baseConnection({
      config: {
        siteUrl: 'https://acme.atlassian.net',
        email: 'admin@acme.com',
        // sprintFieldId omitted — forces resolution via getFields
      },
    });
    const { envelopes } = await collector.poll(connection);

    expect(client.getFields).toHaveBeenCalledWith(
      'https://acme.atlassian.net',
      'admin@acme.com',
      'tok',
    );
    expect(connections.updateConfig).toHaveBeenCalledWith('conn_1', {
      config: expect.objectContaining({ sprintFieldId: 'customfield_10020' }),
      status: 'active',
    });
    // the resolved field id is requested alongside the base fields and read back
    expect(client.searchIssues.mock.calls[0][3]).toMatchObject({
      fields: expect.arrayContaining(['summary', 'customfield_10020']),
    });
    expect(envelopes[0].data).toMatchObject({
      sprint: { externalId: '5', name: 'Sprint 5', goal: 'ship it' },
    });
  });

  it('does not re-query getFields once the custom-field ids are resolved (including "no such field")', async () => {
    client.searchIssues.mockResolvedValue({ issues: [] });

    // default config has sprintFieldId: null + storyPointsFieldIds: []
    await collector.poll(baseConnection());

    expect(client.getFields).not.toHaveBeenCalled();
    // `storyPoints`, `epic` and `epicKey` are deliberately absent — they are
    // not Jira Cloud v3 field ids and only ever resolved to undefined.
    expect(client.searchIssues.mock.calls[0][3]).toMatchObject({
      fields: [
        'summary',
        'status',
        'issuetype',
        'project',
        'parent',
        'fixVersions',
        'assignee',
        'priority',
        'resolutiondate',
        'created',
        'updated',
      ],
    });
  });

  it("carries Jira's own creation date so lead time isn't measured from the ingestion date", async () => {
    client.searchIssues.mockResolvedValue({
      issues: [
        issue('PAY-1', {
          created: '2026-01-04T09:30:00.000Z',
          resolutiondate: '2026-03-02T11:00:00.000Z',
        }),
        // An issue whose `created` Jira didn't return stays undefined rather
        // than defaulting to now — a wrong date here becomes a wrong metric,
        // while an absent one is excluded and disclosed downstream.
        issue('PAY-2'),
      ],
    });

    const { envelopes } = await collector.poll(baseConnection());

    expect(envelopes[0].data).toMatchObject({
      externalKey: 'PAY-1',
      sourceCreatedAt: '2026-01-04T09:30:00.000Z',
    });
    expect(envelopes[1].data.sourceCreatedAt).toBeUndefined();
  });

  it('resolves every plausible story-point field and reads whichever one the issue actually populates', async () => {
    // A site with both a team-managed and a classic story-point field, where
    // only the classic one carries a value — the real shape of a migrated org.
    client.getFields.mockResolvedValue([
      { id: 'summary', name: 'Summary' },
      {
        id: 'customfield_11013',
        name: 'Story point estimate',
        schema: { custom: 'com.pyxis.greenhopper.jira:jsw-story-points' },
      },
      {
        id: 'customfield_10300',
        name: 'Story Points',
        schema: {
          custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
        },
      },
    ]);
    client.searchIssues.mockResolvedValue({
      issues: [
        issue('PAY-1', {
          customfield_11013: null,
          customfield_10300: 8,
        }),
      ],
    });

    const { envelopes } = await collector.poll(
      baseConnection({
        config: {
          siteUrl: 'https://acme.atlassian.net',
          email: 'admin@acme.com',
          // both ids omitted — forces resolution
        },
      }),
    );

    expect(connections.updateConfig).toHaveBeenCalledWith('conn_1', {
      config: expect.objectContaining({
        storyPointsFieldIds: ['customfield_11013', 'customfield_10300'],
      }),
      status: 'active',
    });
    expect(client.searchIssues.mock.calls[0][3]).toMatchObject({
      fields: expect.arrayContaining([
        'customfield_11013',
        'customfield_10300',
      ]),
    });
    // picks the populated one, not merely the first candidate
    expect(envelopes[0].data).toMatchObject({ storyPoints: 8 });
  });

  it('does NOT cache "no such field" when the field lookup itself fails — a transient error must not permanently disable sprint/story-point collection', async () => {
    client.getFields.mockResolvedValue(null); // lookup failed (401/429/5xx)
    client.searchIssues.mockResolvedValue({ issues: [] });

    await collector.poll(
      baseConnection({
        config: {
          siteUrl: 'https://acme.atlassian.net',
          email: 'admin@acme.com',
          // unresolved — and must STAY unresolved after a failed lookup
        },
      }),
    );

    const wroteFieldIds = connections.updateConfig.mock.calls.some(
      ([, arg]) =>
        (arg as { config: Record<string, unknown> }).config
          .storyPointsFieldIds !== undefined,
    );
    expect(wroteFieldIds).toBe(false);
  });

  it("picks the active sprint out of the field's array, falling back to the most recent one", async () => {
    client.searchIssues.mockResolvedValue({
      issues: [
        issue('PAY-1', {
          customfield_10020: [
            { id: 1, name: 'Sprint 1', state: 'closed' },
            { id: 2, name: 'Sprint 2', state: 'closed' },
          ],
        }),
      ],
    });

    const { envelopes } = await collector.poll(
      baseConnection({
        config: {
          siteUrl: 'https://acme.atlassian.net',
          email: 'admin@acme.com',
          sprintFieldId: 'customfield_10020',
        },
      }),
    );

    // no sprint is active — falls back to the last (most recent) entry
    expect(envelopes[0].data).toMatchObject({
      sprint: { externalId: '2', name: 'Sprint 2' },
    });
  });

  it('extracts the status-transition timeline and current status category from the change log', async () => {
    client.searchIssues.mockResolvedValue({
      issues: [
        {
          key: 'PAY-1',
          fields: {
            summary: 't',
            project: { key: 'PAY' },
            updated: '2026-06-05T00:00:00.000Z',
            status: {
              name: 'ACCEPTED IN UAT',
              statusCategory: { key: 'done' },
            },
          },
          changelog: {
            total: 3,
            histories: [
              {
                id: '900',
                created: '2026-06-03T00:00:00.000Z',
                author: { accountId: 'acc_1', displayName: 'Jane Doe' },
                // an entry groups every field changed at once — only status counts
                items: [
                  { field: 'assignee', fromString: null, toString: 'Jane' },
                  {
                    field: 'status',
                    fromString: 'In Progress',
                    toString: 'ACCEPTED IN UAT',
                  },
                ],
              },
              {
                id: '800',
                created: '2026-06-01T00:00:00.000Z',
                items: [
                  { field: 'status', fromString: null, toString: 'To Do' },
                ],
              },
              // no status item at all — must not become a transition
              {
                id: '850',
                created: '2026-06-02T00:00:00.000Z',
                items: [{ field: 'priority', toString: 'High' }],
              },
            ],
          },
        },
      ],
    });

    const { envelopes } = await collector.poll(baseConnection());

    const data = envelopes[0].data as unknown as {
      statusCategory?: string;
      transitions?: {
        changelogId: string;
        fromStatus?: string;
        toStatus: string;
        at: string;
        authorName?: string;
      }[];
    };
    expect(data.statusCategory).toBe('done');
    // oldest-first, non-status entries dropped
    expect(data.transitions).toEqual([
      {
        changelogId: '800',
        fromStatus: undefined,
        toStatus: 'To Do',
        at: '2026-06-01T00:00:00.000Z',
        authorLogin: undefined,
        authorName: undefined,
      },
      {
        changelogId: '900',
        fromStatus: 'In Progress',
        toStatus: 'ACCEPTED IN UAT',
        at: '2026-06-03T00:00:00.000Z',
        authorLogin: 'acc_1',
        authorName: 'Jane Doe',
      },
    ]);
  });

  it('extracts sprint scope changes from the change log, diffed into added/removed ids', async () => {
    client.searchIssues.mockResolvedValue({
      issues: [
        {
          key: 'PAY-1',
          fields: {
            summary: 't',
            project: { key: 'PAY' },
            updated: '2026-06-05T00:00:00.000Z',
            status: { name: 'To Do' },
          },
          changelog: {
            total: 4,
            histories: [
              {
                id: '760',
                created: '2026-06-04T00:00:00.000Z',
                items: [
                  // Jira's Sprint field accretes history — dropping an id is
                  // the only signal a story LEFT a sprint.
                  {
                    field: 'Sprint',
                    from: '5, 7',
                    to: '7',
                    fromString: 'Sprint 5, Sprint 7',
                    toString: 'Sprint 7',
                  },
                ],
              },
              {
                id: '700',
                created: '2026-06-01T00:00:00.000Z',
                author: { accountId: 'acc_1', displayName: 'Jane Doe' },
                items: [
                  {
                    field: 'Sprint',
                    fieldId: 'customfield_10020',
                    from: '',
                    to: '5',
                    fromString: '',
                    toString: 'Sprint 5',
                  },
                ],
              },
              {
                id: '750',
                created: '2026-06-02T00:00:00.000Z',
                items: [
                  {
                    field: 'Sprint',
                    from: '5',
                    to: '5, 7',
                    fromString: 'Sprint 5',
                    toString: 'Sprint 5, Sprint 7',
                  },
                ],
              },
              // no sprint item — must not become a scope change
              {
                id: '850',
                created: '2026-06-03T00:00:00.000Z',
                items: [{ field: 'priority', toString: 'High' }],
              },
            ],
          },
        },
      ],
    });

    const { envelopes } = await collector.poll(baseConnection());

    const data = envelopes[0].data as unknown as {
      sprintChanges?: {
        changelogId: string;
        addedSprintIds: string[];
        removedSprintIds: string[];
        at: string;
        authorLogin?: string;
        authorName?: string;
      }[];
    };
    // oldest-first, non-sprint entries dropped
    expect(data.sprintChanges).toEqual([
      {
        changelogId: '700',
        addedSprintIds: ['5'],
        removedSprintIds: [],
        at: '2026-06-01T00:00:00.000Z',
        authorLogin: 'acc_1',
        authorName: 'Jane Doe',
      },
      {
        changelogId: '750',
        addedSprintIds: ['7'],
        removedSprintIds: [],
        at: '2026-06-02T00:00:00.000Z',
        authorLogin: undefined,
        authorName: undefined,
      },
      {
        changelogId: '760',
        addedSprintIds: [],
        removedSprintIds: ['5'],
        at: '2026-06-04T00:00:00.000Z',
        authorLogin: undefined,
        authorName: undefined,
      },
    ]);
  });

  it('keys envelopes with the v2 idempotency scheme, so a re-walk re-projects issues collected under v1', async () => {
    client.searchIssues.mockResolvedValue({
      issues: [
        {
          key: 'PAY-1',
          fields: {
            summary: 't',
            project: { key: 'PAY' },
            updated: '2026-06-05T00:00:00.000Z',
            status: { name: 'To Do' },
          },
        },
      ],
    });

    const { envelopes } = await collector.poll(baseConnection());

    // v1 keys (`jira:{key}:{type}:{updated}`) drop a re-collected-but-unchanged
    // issue before the projector — which made sprint scope history unreachable
    // for every already-stored story. Webhook and poll still converge: both
    // build the same v2 key.
    expect(envelopes[0].idempotencyKey).toBe(
      'jira:v2:PAY-1:planning.issue.updated:2026-06-05T00:00:00.000Z',
    );
  });

  it('requests the change log inline rather than per issue', async () => {
    client.searchIssues.mockResolvedValue({ issues: [] });

    await collector.poll(baseConnection());

    expect(client.searchIssues.mock.calls[0][3]).toMatchObject({
      withChangelog: true,
    });
    expect(client.getIssueChangelog).not.toHaveBeenCalled();
  });

  it('completes a change log the search truncated, and keeps the partial one if that fetch fails', async () => {
    const truncated = {
      key: 'PAY-1',
      fields: {
        summary: 't',
        project: { key: 'PAY' },
        updated: '2026-06-05T00:00:00.000Z',
        status: { name: 'Done', statusCategory: { key: 'done' } },
      },
      // total exceeds what came back — the rest has to be fetched
      changelog: {
        total: 2,
        histories: [
          {
            id: '900',
            created: '2026-06-03T00:00:00.000Z',
            items: [{ field: 'status', fromString: 'To Do', toString: 'Done' }],
          },
        ],
      },
    };
    client.searchIssues.mockResolvedValue({ issues: [truncated] });
    client.getIssueChangelog.mockResolvedValue([
      {
        id: '800',
        created: '2026-06-01T00:00:00.000Z',
        items: [{ field: 'status', fromString: null, toString: 'To Do' }],
      },
      {
        id: '900',
        created: '2026-06-03T00:00:00.000Z',
        items: [{ field: 'status', fromString: 'To Do', toString: 'Done' }],
      },
    ]);

    let { envelopes } = await collector.poll(baseConnection());
    expect(client.getIssueChangelog).toHaveBeenCalledWith(
      'https://acme.atlassian.net',
      'admin@acme.com',
      'tok',
      'PAY-1',
    );
    let data = envelopes[0].data as unknown as { transitions?: unknown[] };
    expect(data.transitions).toHaveLength(2);

    // A failed completion fetch must not throw away the embedded entry.
    jest.clearAllMocks();
    secrets.resolve.mockResolvedValue('tok');
    client.searchIssues.mockResolvedValue({ issues: [truncated] });
    client.getIssueChangelog.mockResolvedValue(null);

    ({ envelopes } = await collector.poll(baseConnection()));
    data = envelopes[0].data as unknown as { transitions?: unknown[] };
    expect(data.transitions).toHaveLength(1);
  });

  it('turns an issue-updated webhook into the single transition it carries', async () => {
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_updated',
      user: { accountId: 'acc_9', displayName: 'Ken Chan' },
      changelog: {
        id: '4242',
        items: [
          { field: 'status', fromString: 'To Do', toString: 'In Progress' },
        ],
      },
      issue: {
        key: 'PAY-7',
        fields: {
          summary: 'x',
          project: { key: 'PAY' },
          updated: '2026-06-09T00:00:00.000Z',
          status: {
            name: 'In Progress',
            statusCategory: { key: 'indeterminate' },
          },
        },
      },
    });

    const envelopes = await collector.normalizeWebhook(
      baseConnection(),
      Buffer.from(body),
      {},
    );

    const data = envelopes[0].data as unknown as {
      statusCategory?: string;
      transitions?: { changelogId: string; toStatus: string }[];
    };
    expect(data.statusCategory).toBe('indeterminate');
    // Same changelog id the poller would see, so the two converge on one row.
    expect(data.transitions).toEqual([
      expect.objectContaining({
        changelogId: '4242',
        fromStatus: 'To Do',
        toStatus: 'In Progress',
      }),
    ]);
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

  it('marks backfillCompletedAt exactly once — the tick the historical backfill first finishes', async () => {
    client.searchIssues.mockResolvedValue({ issues: [] });

    await collector.poll(baseConnection({ backfillCompletedAt: null })); // fresh connection, no syncCursors yet

    expect(connections.setBackfillCompletedAt).toHaveBeenCalledWith('conn_1');
  });

  it('does not re-mark backfillCompletedAt on a genuine steady-state (already recorded) tick', async () => {
    client.searchIssues.mockResolvedValue({ issues: [] });

    await collector.poll(
      baseConnection({
        syncCursors: { updatedCursor: '2026-06-15T12:00:00.000Z' },
        backfillCompletedAt: new Date('2026-06-16T00:00:00.000Z'),
      }),
    );

    expect(connections.setBackfillCompletedAt).not.toHaveBeenCalled();
  });

  it('self-heals a connection whose cursors already show full backfill but whose backfillCompletedAt was never recorded (predates the tracking column)', async () => {
    client.searchIssues.mockResolvedValue({ issues: [] });

    await collector.poll(
      baseConnection({
        syncCursors: { updatedCursor: '2026-06-15T12:00:00.000Z' },
        backfillCompletedAt: null,
      }),
    );

    expect(connections.setBackfillCompletedAt).toHaveBeenCalledWith('conn_1');
  });
});
