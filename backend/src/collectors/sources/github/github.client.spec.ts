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

  it('lists org repos with type=all (so private repos the token can see are included)', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: [
          { full_name: 'athmahealth/api', archived: false, disabled: false },
        ],
      }),
    ) as unknown as typeof fetch;

    const page = await client.listOrgReposPage('athmahealth', 'tok', 1);

    expect(page.items).toEqual([
      { full_name: 'athmahealth/api', archived: false, disabled: false },
    ]);
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toBe(
      'https://api.github.com/orgs/athmahealth/repos?type=all&per_page=100&page=1',
    );
  });

  describe('getCommitDetail', () => {
    it('returns additions/deletions/filesChanged from the per-commit endpoint', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        fakeResponse({
          headers: { 'x-ratelimit-remaining': '500' },
          body: {
            stats: { additions: 12, deletions: 4 },
            files: [{ filename: 'a.ts' }, { filename: 'b.ts' }],
          },
        }),
      ) as unknown as typeof fetch;

      const detail = await client.getCommitDetail(
        'acme/payments',
        'tok',
        'abc123',
      );

      expect(detail).toEqual({
        additions: 12,
        deletions: 4,
        filesChanged: 2,
      });
      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(url).toBe(
        'https://api.github.com/repos/acme/payments/commits/abc123',
      );
    });

    it('signals rateLimitedUntil on a 403/429 instead of throwing', async () => {
      const resetEpoch = Math.floor(Date.now() / 1000) + 90;
      global.fetch = jest.fn().mockResolvedValue(
        fakeResponse({
          ok: false,
          status: 403,
          headers: { 'x-ratelimit-reset': String(resetEpoch) },
        }),
      ) as unknown as typeof fetch;

      const detail = await client.getCommitDetail(
        'acme/payments',
        'tok',
        'abc123',
      );

      expect(detail.additions).toBeUndefined();
      expect(detail.rateLimitedUntil?.getTime()).toBe(resetEpoch * 1000);
    });

    it('preempts a hard rate limit when remaining drops to 1, keeping the detail just fetched', async () => {
      const resetEpoch = Math.floor(Date.now() / 1000) + 60;
      global.fetch = jest.fn().mockResolvedValue(
        fakeResponse({
          headers: {
            'x-ratelimit-remaining': '1',
            'x-ratelimit-reset': String(resetEpoch),
          },
          body: { stats: { additions: 1, deletions: 1 }, files: [] },
        }),
      ) as unknown as typeof fetch;

      const detail = await client.getCommitDetail(
        'acme/payments',
        'tok',
        'abc123',
      );

      expect(detail.additions).toBe(1);
      expect(detail.rateLimitedUntil).toBeInstanceOf(Date);
    });

    it('returns {} without calling fetch when no token is configured', async () => {
      global.fetch = jest.fn() as unknown as typeof fetch;

      const detail = await client.getCommitDetail(
        'acme/payments',
        '',
        'abc123',
      );

      expect(detail).toEqual({});
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('getPullRequestDetail', () => {
    it('returns additions/deletions/changedFiles from the per-PR endpoint', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        fakeResponse({
          headers: { 'x-ratelimit-remaining': '500' },
          body: { additions: 142, deletions: 38, changed_files: 6 },
        }),
      ) as unknown as typeof fetch;

      const detail = await client.getPullRequestDetail(
        'acme/payments',
        'tok',
        4521,
      );

      expect(detail).toMatchObject({
        additions: 142,
        deletions: 38,
        changedFiles: 6,
        mergedBy: undefined,
      });
      // Surfaced so bulk backfill can stop while quota remains, instead of
      // draining the token and starving the scheduled sync.
      expect(detail.rateLimit?.remaining).toBe(500);
      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(url).toBe('https://api.github.com/repos/acme/payments/pulls/4521');
    });

    it('returns merged_by, which only this endpoint carries (self_merge_rate)', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        fakeResponse({
          headers: { 'x-ratelimit-remaining': '500' },
          body: {
            additions: 1,
            deletions: 1,
            changed_files: 1,
            merged_by: { login: 'asmith' },
          },
        }),
      ) as unknown as typeof fetch;

      const detail = await client.getPullRequestDetail(
        'acme/payments',
        'tok',
        4521,
      );

      expect(detail.mergedBy).toBe('asmith');
    });

    it('signals rateLimitedUntil on a 403/429 instead of throwing', async () => {
      const resetEpoch = Math.floor(Date.now() / 1000) + 90;
      global.fetch = jest.fn().mockResolvedValue(
        fakeResponse({
          ok: false,
          status: 403,
          headers: { 'x-ratelimit-reset': String(resetEpoch) },
        }),
      ) as unknown as typeof fetch;

      const detail = await client.getPullRequestDetail(
        'acme/payments',
        'tok',
        4521,
      );

      expect(detail.additions).toBeUndefined();
      expect(detail.rateLimitedUntil?.getTime()).toBe(resetEpoch * 1000);
    });

    it('preempts a hard rate limit when remaining drops to 1, keeping the detail just fetched', async () => {
      const resetEpoch = Math.floor(Date.now() / 1000) + 60;
      global.fetch = jest.fn().mockResolvedValue(
        fakeResponse({
          headers: {
            'x-ratelimit-remaining': '1',
            'x-ratelimit-reset': String(resetEpoch),
          },
          body: { additions: 1, deletions: 1, changed_files: 1 },
        }),
      ) as unknown as typeof fetch;

      const detail = await client.getPullRequestDetail(
        'acme/payments',
        'tok',
        4521,
      );

      expect(detail.additions).toBe(1);
      expect(detail.rateLimitedUntil).toBeInstanceOf(Date);
    });

    it('returns {} without calling fetch when no token is configured', async () => {
      global.fetch = jest.fn() as unknown as typeof fetch;

      const detail = await client.getPullRequestDetail(
        'acme/payments',
        '',
        4521,
      );

      expect(detail).toEqual({});
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('listPullRequestReviews', () => {
    it('maps submitted reviews and drops PENDING drafts', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        fakeResponse({
          headers: { 'x-ratelimit-remaining': '500' },
          body: [
            {
              id: 991,
              user: { login: 'asmith' },
              state: 'APPROVED',
              submitted_at: '2026-06-30T09:40:00Z',
              body: 'looks good',
            },
            // Never submitted — visible only to its author, so counting it
            // would credit a review nobody has received.
            {
              id: 992,
              user: { login: 'bjones' },
              state: 'PENDING',
              submitted_at: null,
              body: '',
            },
            {
              id: 993,
              user: { login: 'bjones' },
              state: 'CHANGES_REQUESTED',
              submitted_at: '2026-06-30T10:00:00Z',
              body: '   ',
            },
          ],
        }),
      ) as unknown as typeof fetch;

      const result = await client.listPullRequestReviews(
        'acme/payments',
        'tok',
        4521,
      );

      expect(result.reviews).toEqual([
        {
          externalId: '991',
          reviewerLogin: 'asmith',
          isBot: false,
          state: 'approved',
          submittedAt: '2026-06-30T09:40:00Z',
          hasBody: true,
        },
        {
          externalId: '993',
          reviewerLogin: 'bjones',
          isBot: false,
          state: 'changes_requested',
          submittedAt: '2026-06-30T10:00:00Z',
          // Whitespace-only body is not a written review.
          hasBody: false,
        },
      ]);
    });

    it("classifies bots from GitHub's user.type and the [bot] login convention", async () => {
      global.fetch = jest.fn().mockResolvedValue(
        fakeResponse({
          headers: { 'x-ratelimit-remaining': '500' },
          body: [
            // Authoritative signal.
            {
              id: 1,
              user: { login: 'some-app', type: 'Bot' },
              state: 'APPROVED',
              submitted_at: '2026-06-30T09:00:00Z',
            },
            // `user.type` absent — the login convention is the fallback.
            {
              id: 2,
              user: { login: 'copilot-pull-request-reviewer[bot]' },
              state: 'COMMENTED',
              submitted_at: '2026-06-30T09:10:00Z',
            },
            {
              id: 3,
              user: { login: 'asmith', type: 'User' },
              state: 'APPROVED',
              submitted_at: '2026-06-30T09:20:00Z',
            },
          ],
        }),
      ) as unknown as typeof fetch;

      const result = await client.listPullRequestReviews(
        'acme/payments',
        'tok',
        4521,
      );

      expect(result.reviews.map((r) => r.isBot)).toEqual([true, true, false]);
    });

    it('flags a failure instead of returning an empty list', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          fakeResponse({ ok: false, status: 500 }),
        ) as unknown as typeof fetch;

      const result = await client.listPullRequestReviews(
        'acme/payments',
        'tok',
        4521,
      );

      // "Merged unreviewed" is a reportable finding — a 500 must not become one.
      expect(result).toEqual({ reviews: [], failed: true });
    });

    it('signals rateLimitedUntil on a 403/429 instead of throwing', async () => {
      const resetEpoch = Math.floor(Date.now() / 1000) + 90;
      global.fetch = jest.fn().mockResolvedValue(
        fakeResponse({
          ok: false,
          status: 403,
          headers: { 'x-ratelimit-reset': String(resetEpoch) },
        }),
      ) as unknown as typeof fetch;

      const result = await client.listPullRequestReviews(
        'acme/payments',
        'tok',
        4521,
      );

      expect(result.rateLimitedUntil?.getTime()).toBe(resetEpoch * 1000);
      expect(result.failed).toBeUndefined();
    });
  });

  describe('listPullRequestCommits', () => {
    it("returns the PR's commit subjects, skipping entries without one", async () => {
      global.fetch = jest.fn().mockResolvedValue(
        fakeResponse({
          headers: { 'x-ratelimit-remaining': '500' },
          body: [
            { commit: { message: 'PAY-2231 guard duplicate capture' } },
            { commit: {} },
            { sha: 'abc' },
            { commit: { message: 'fix typo' } },
          ],
        }),
      ) as unknown as typeof fetch;

      const result = await client.listPullRequestCommits(
        'acme/payments',
        'tok',
        4521,
      );

      expect(result.messages).toEqual([
        'PAY-2231 guard duplicate capture',
        'fix typo',
      ]);
      // The reserve stop (github-rate-budget) needs the remaining quota — the
      // bulk reconciler would otherwise only halt at a hard 403.
      expect(result.rateLimit).toEqual({
        remaining: 500,
        resetAt: expect.any(Date),
      });
      expect(result.failed).toBeUndefined();
      const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(url).toBe(
        'https://api.github.com/repos/acme/payments/pulls/4521/commits?per_page=100',
      );
    });

    it('signals rateLimitedUntil on a 403/429 instead of throwing', async () => {
      const resetEpoch = Math.floor(Date.now() / 1000) + 90;
      global.fetch = jest.fn().mockResolvedValue(
        fakeResponse({
          ok: false,
          status: 429,
          headers: { 'x-ratelimit-reset': String(resetEpoch) },
        }),
      ) as unknown as typeof fetch;

      const result = await client.listPullRequestCommits(
        'acme/payments',
        'tok',
        4521,
      );

      expect(result.messages).toEqual([]);
      expect(result.rateLimitedUntil?.getTime()).toBe(resetEpoch * 1000);
    });

    it('marks a non-rate-limit failure as failed rather than throwing', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          fakeResponse({ ok: false, status: 404 }),
        ) as unknown as typeof fetch;

      const result = await client.listPullRequestCommits(
        'acme/payments',
        'tok',
        4521,
      );

      // For correlation the outcome matches a PR whose commits carry no key —
      // no extra match — but `failed` keeps the two apart for the reconciler:
      // an unanswered request must stay a candidate, not be stamped as
      // "asked and this PR genuinely has no messages".
      expect(result.messages).toEqual([]);
      expect(result.failed).toBe(true);
    });

    it('returns no messages without calling fetch when no token is configured', async () => {
      global.fetch = jest.fn() as unknown as typeof fetch;

      const result = await client.listPullRequestCommits(
        'acme/payments',
        '',
        4521,
      );

      // Never asked, so not answered — same `failed` contract as a 404.
      expect(result.messages).toEqual([]);
      expect(result.failed).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
