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

  it('returns issues, total, and no rate-limit signal on success', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: { issues: [{ key: 'PAY-1', fields: {} }], total: 1 },
      }),
    ) as unknown as typeof fetch;

    const page = await client.searchIssues(
      'https://acme.atlassian.net',
      'a@b.com',
      'tok',
      {
        jql: 'updated >= "2026/01/01 00:00" ORDER BY updated ASC',
        startAt: 0,
        maxResults: 50,
      },
    );

    expect(page.issues).toEqual([{ key: 'PAY-1', fields: {} }]);
    expect(page.total).toBe(1);
    expect(page.rateLimitedUntil).toBeUndefined();
  });

  it('sends Basic auth built from email:apiToken', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ body: {} })) as unknown as typeof fetch;

    await client.searchIssues('https://acme.atlassian.net', 'a@b.com', 'tok', {
      jql: 'updated >= "2026/01/01 00:00"',
      startAt: 0,
      maxResults: 50,
    });

    const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('a@b.com:tok').toString('base64')}`,
    );
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
        startAt: 0,
        maxResults: 50,
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
        startAt: 0,
        maxResults: 50,
      },
    );

    expect(page.issues).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
