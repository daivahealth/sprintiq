import { JiraClient } from './jira.client';

function fakeResponse(opts: {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  const headers = new Map(Object.entries(opts.headers ?? {}));
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (key: string) => headers.get(key.toLowerCase()) ?? null },
    json: async () => opts.body ?? {},
  };
}

describe('JiraClient', () => {
  const client = new JiraClient();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns issues, nextPageToken, and no rate-limit signal on success', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: {
          issues: [{ key: 'PAY-1', fields: {} }],
          nextPageToken: 'tok_2',
        },
      }),
    ) as unknown as typeof fetch;

    const page = await client.searchIssues(
      'https://acme.atlassian.net',
      'a@b.com',
      'tok',
      {
        jql: 'updated >= "2026/01/01 00:00" ORDER BY updated ASC',
        maxResults: 50,
        fields: ['summary'],
      },
    );

    expect(page.issues).toEqual([{ key: 'PAY-1', fields: {} }]);
    expect(page.nextPageToken).toBe('tok_2');
    expect(page.rateLimitedUntil).toBeUndefined();
  });

  it('POSTs to the enhanced JQL search endpoint with Basic auth and the page token', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ body: {} })) as unknown as typeof fetch;

    await client.searchIssues('https://acme.atlassian.net', 'a@b.com', 'tok', {
      jql: 'updated >= "2026/01/01 00:00"',
      maxResults: 50,
      fields: ['summary'],
      pageToken: 'tok_1',
    });

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/search/jql');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('a@b.com:tok').toString('base64')}`,
    );
    const body = JSON.parse(init.body as string);
    expect(body.jql).toBe('updated >= "2026/01/01 00:00"');
    expect(body.maxResults).toBe(50);
    expect(body.fields).toEqual(['summary']);
    expect(body.nextPageToken).toBe('tok_1');
  });

  it('sends expand as a comma-separated STRING when the change log is requested (an array is rejected with 400)', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ body: {} })) as unknown as typeof fetch;

    await client.searchIssues('https://acme.atlassian.net', 'a@b.com', 'tok', {
      jql: 'updated >= "2026/01/01 00:00"',
      maxResults: 50,
      fields: ['summary'],
      withChangelog: true,
    });

    const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.expand).toBe('changelog');
  });

  it('omits expand entirely when the change log is not requested', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ body: {} })) as unknown as typeof fetch;

    await client.searchIssues('https://acme.atlassian.net', 'a@b.com', 'tok', {
      jql: 'updated >= "2026/01/01 00:00"',
      maxResults: 50,
      fields: ['summary'],
    });

    const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string).expand).toBeUndefined();
  });

  it('signals rateLimitedUntil from Retry-After on a 429', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        ok: false,
        status: 429,
        headers: { 'retry-after': '30' },
      }),
    ) as unknown as typeof fetch;

    const before = Date.now();
    const page = await client.searchIssues(
      'https://acme.atlassian.net',
      'a@b.com',
      'tok',
      {
        jql: 'updated >= "2026/01/01 00:00"',
        maxResults: 50,
        fields: ['summary'],
      },
    );

    expect(page.issues).toEqual([]);
    expect(page.rateLimitedUntil?.getTime()).toBeGreaterThanOrEqual(
      before + 29_000,
    );
  });

  it('signals failed:true (not just empty issues) on a non-2xx, non-429 response', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: false, status: 400 }),
      ) as unknown as typeof fetch;

    const page = await client.searchIssues(
      'https://acme.atlassian.net',
      'a@b.com',
      'tok',
      {
        jql: 'updated >= "2026/01/01 00:00"',
        maxResults: 50,
        fields: ['summary'],
        pageToken: 'tok_expired',
      },
    );

    expect(page.issues).toEqual([]);
    expect(page.failed).toBe(true);
    expect(page.nextPageToken).toBeUndefined();
  });

  it('returns empty without calling fetch when no API token is configured', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;

    const page = await client.searchIssues(
      'https://acme.atlassian.net',
      'a@b.com',
      '',
      {
        jql: 'updated >= "2026/01/01 00:00"',
        maxResults: 50,
        fields: ['summary'],
      },
    );

    expect(page.issues).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  describe('getIssueChangelog', () => {
    it('pages through the full history until isLast', async () => {
      const page1 = {
        values: [{ id: '1', created: '2026-06-01T00:00:00.000Z', items: [] }],
        isLast: false,
      };
      const page2 = {
        values: [{ id: '2', created: '2026-06-02T00:00:00.000Z', items: [] }],
        isLast: true,
      };
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(fakeResponse({ body: page1 }))
        .mockResolvedValueOnce(
          fakeResponse({ body: page2 }),
        ) as unknown as typeof fetch;

      const entries = await client.getIssueChangelog(
        'https://acme.atlassian.net',
        'a@b.com',
        'tok',
        'PAY-1',
      );

      expect(entries?.map((e) => e.id)).toEqual(['1', '2']);
      expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(
        '/rest/api/3/issue/PAY-1/changelog',
      );
    });

    it('returns null on failure so the caller keeps the partial history it already has', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          fakeResponse({ ok: false, status: 500 }),
        ) as unknown as typeof fetch;

      const entries = await client.getIssueChangelog(
        'https://acme.atlassian.net',
        'a@b.com',
        'tok',
        'PAY-1',
      );

      expect(entries).toBeNull();
    });
  });

  describe('getFields', () => {
    it('returns the site field catalog on success', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        fakeResponse({
          body: [
            { id: 'summary', name: 'Summary' },
            {
              id: 'customfield_10020',
              name: 'Sprint',
              schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' },
            },
          ],
        }),
      ) as unknown as typeof fetch;

      const fields = await client.getFields(
        'https://acme.atlassian.net',
        'a@b.com',
        'tok',
      );

      expect(fields).toHaveLength(2);
      expect(fields?.[1]).toMatchObject({ id: 'customfield_10020' });
      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(url).toBe('https://acme.atlassian.net/rest/api/3/field');
    });

    it('returns null (not []) on a failed response, so callers can tell failure from "no such field"', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          fakeResponse({ ok: false, status: 403 }),
        ) as unknown as typeof fetch;

      const fields = await client.getFields(
        'https://acme.atlassian.net',
        'a@b.com',
        'tok',
      );

      expect(fields).toBeNull();
    });

    it('returns null without calling fetch when no API token is configured', async () => {
      global.fetch = jest.fn() as unknown as typeof fetch;

      const fields = await client.getFields(
        'https://acme.atlassian.net',
        'a@b.com',
        '',
      );

      expect(fields).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  it('GETs the project versions endpoint with Basic auth', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ body: [] })) as unknown as typeof fetch;

    await client.getProjectVersions(
      'https://acme.atlassian.net',
      'a@b.com',
      'tok',
      'ACT',
    );

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://acme.atlassian.net/rest/api/3/project/ACT/versions',
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('a@b.com:tok').toString('base64')}`,
    );
  });

  it('returns the versions it was given', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: [
          {
            id: '10042',
            name: 'RC1',
            startDate: '2026-08-14',
            releaseDate: '2026-08-22',
            released: true,
            archived: false,
            overdue: false,
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const versions = await client.getProjectVersions(
      'https://acme.atlassian.net',
      'a@b.com',
      'tok',
      'ACT',
    );

    expect(versions).toEqual([
      {
        id: '10042',
        name: 'RC1',
        startDate: '2026-08-14',
        releaseDate: '2026-08-22',
        released: true,
        archived: false,
        overdue: false,
      },
    ]);
  });

  // Null, not []: the caller must be able to tell "this project has no
  // versions" from "we could not ask". Treating a 401 as an empty list would
  // mark every RC as unknown-dated and look like real data.
  it('returns null (not an empty list) when the request fails', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: false, status: 401 }),
      ) as unknown as typeof fetch;

    const versions = await client.getProjectVersions(
      'https://acme.atlassian.net',
      'a@b.com',
      'tok',
      'ACT',
    );

    expect(versions).toBeNull();
  });

  it('returns null when no API token is available', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;

    const versions = await client.getProjectVersions(
      'https://acme.atlassian.net',
      'a@b.com',
      '',
      'ACT',
    );

    expect(versions).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('JiraClient.getSprint', () => {
  const client = new JiraClient();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GETs the Agile sprint endpoint with Basic auth', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ body: {} })) as unknown as typeof fetch;

    await client.getSprint(
      'https://acme.atlassian.net',
      'a@b.com',
      'tok',
      '3238',
    );

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://acme.atlassian.net/rest/agile/1.0/sprint/3238');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('a@b.com:tok').toString('base64')}`,
    );
  });

  it('returns the sprint it was given', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: {
          id: 3238,
          name: 'Sprint-26-3',
          state: 'closed',
          startDate: '2026-03-01T00:00:00.000+0530',
          endDate: '2026-03-30T00:00:00.000+0530',
          completeDate: '2026-03-31T09:12:00.000+0530',
          goal: 'Ship the referral editor',
        },
      }),
    ) as unknown as typeof fetch;

    const sprint = await client.getSprint(
      'https://acme.atlassian.net',
      'a@b.com',
      'tok',
      '3238',
    );

    expect(sprint).toMatchObject({
      id: 3238,
      name: 'Sprint-26-3',
      state: 'closed',
      startDate: '2026-03-01T00:00:00.000+0530',
      endDate: '2026-03-30T00:00:00.000+0530',
    });
  });

  // Null, not a stub sprint: a transient 401/429 must never be written to the
  // board as a real sprint with no dates — that is worse than the gap it fills.
  it('returns null when the request fails', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: false, status: 429 }),
      ) as unknown as typeof fetch;

    expect(
      await client.getSprint(
        'https://acme.atlassian.net',
        'a@b.com',
        'tok',
        '3238',
      ),
    ).toBeNull();
  });

  // A sprint id that no longer exists in Jira (deleted board) 404s. That is a
  // permanent answer, not a transient one, but it is still not a sprint —
  // the caller must not create a row from it.
  it('returns null for a sprint Jira no longer has', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: false, status: 404 }),
      ) as unknown as typeof fetch;

    expect(
      await client.getSprint(
        'https://acme.atlassian.net',
        'a@b.com',
        'tok',
        '999',
      ),
    ).toBeNull();
  });

  it('returns null when no API token is available', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;

    expect(
      await client.getSprint(
        'https://acme.atlassian.net',
        'a@b.com',
        '',
        '3238',
      ),
    ).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
