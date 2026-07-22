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
      expect(fields[1]).toMatchObject({ id: 'customfield_10020' });
      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(url).toBe('https://acme.atlassian.net/rest/api/3/field');
    });

    it('returns [] on a failed response instead of throwing', async () => {
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

      expect(fields).toEqual([]);
    });

    it('returns [] without calling fetch when no API token is configured', async () => {
      global.fetch = jest.fn() as unknown as typeof fetch;

      const fields = await client.getFields(
        'https://acme.atlassian.net',
        'a@b.com',
        '',
      );

      expect(fields).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
