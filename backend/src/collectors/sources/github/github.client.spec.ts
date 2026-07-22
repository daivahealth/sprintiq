import { GithubClient } from './github.client';

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
    json: async () => opts.body ?? [],
  };
}

describe('GithubClient', () => {
  const client = new GithubClient();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns items and follows the Link header for pagination', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        headers: {
          link: '<https://api.github.com/repos/acme/payments/pulls?page=2>; rel="next"',
          'x-ratelimit-remaining': '4999',
        },
        body: [{ number: 1 }],
      }),
    ) as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', 'tok', 1);

    expect(page.items).toEqual([{ number: 1 }]);
    expect(page.hasNextPage).toBe(true);
    expect(page.rateLimitedUntil).toBeUndefined();
  });

  it('reports no next page when the Link header omits rel="next"', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ headers: { 'x-ratelimit-remaining': '100' }, body: [] }),
      ) as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', 'tok', 3);

    expect(page.hasNextPage).toBe(false);
  });

  it('signals rateLimitedUntil on a 403/429 response instead of throwing', async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 120;
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        ok: false,
        status: 403,
        headers: { 'x-ratelimit-reset': String(resetEpoch) },
      }),
    ) as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', 'tok', 1);

    expect(page.items).toEqual([]);
    expect(page.rateLimitedUntil?.getTime()).toBe(resetEpoch * 1000);
  });

  it('preempts a hard rate limit when remaining drops to 1, without discarding the page just fetched', async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 60;
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        headers: {
          'x-ratelimit-remaining': '1',
          'x-ratelimit-reset': String(resetEpoch),
        },
        body: [{ number: 42 }],
      }),
    ) as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', 'tok', 1);

    expect(page.items).toEqual([{ number: 42 }]);
    expect(page.hasNextPage).toBe(false);
    expect(page.rateLimitedUntil).toBeInstanceOf(Date);
  });

  it('returns empty without calling fetch when no token is configured', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', '', 1);

    expect(page.items).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('passes `since` through to the commits endpoint', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ body: [] })) as unknown as typeof fetch;

    await client.listCommitsPage(
      'acme/payments',
      'tok',
      1,
      '2026-01-01T00:00:00.000Z',
    );

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('since=2026-01-01T00%3A00%3A00.000Z');
  });
});
