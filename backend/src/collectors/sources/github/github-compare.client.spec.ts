import { GithubClient } from './github.client';

function res(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  const h = new Map(Object.entries(opts.headers ?? {}));
  return {
    ok: (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => opts.body ?? {},
  };
}

const commit = (sha: string, parents = 1, login?: string) => ({
  sha,
  commit: {
    message: `msg ${sha}`,
    author: { name: 'Arun', email: 'arun@x.org', date: '2026-09-25T10:00:00Z' },
    committer: { date: '2026-09-25T10:05:00Z' },
  },
  author: login ? { login } : null,
  parents: Array.from({ length: parents }, (_, i) => ({ sha: `p${i}` })),
});

describe('GithubClient REST additions', () => {
  const client = new GithubClient();
  afterEach(() => jest.restoreAllMocks());

  it('listHeadRefs maps every branch tip from one matching-refs call', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      res({
        body: [
          { ref: 'refs/heads/master', object: { sha: 'm1' } },
          { ref: 'refs/heads/ACT-92441-aot-induction', object: { sha: 'b1' } },
        ],
        headers: { 'x-ratelimit-remaining': '4990' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const r = await client.listHeadRefs('acme/ehr', 'tok');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/acme/ehr/git/matching-refs/heads/',
    );
    expect([...(r.tips ?? new Map())]).toEqual([
      ['master', 'm1'],
      ['ACT-92441-aot-induction', 'b1'],
    ]);
    expect(r.rateLimit?.remaining).toBe(4990);
  });

  it('listHeadRefs reports not_found for a vanished repo', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(res({ status: 404 })) as unknown as typeof fetch;
    expect((await client.listHeadRefs('acme/gone', 'tok')).failure).toBe(
      'not_found',
    );
  });

  it('getDefaultBranch reads default_branch', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(res({ body: { default_branch: 'master' } })) as unknown as typeof fetch;
    expect((await client.getDefaultBranch('acme/ehr', 'tok')).name).toBe(
      'master',
    );
  });

  it('compareAll follows rel="next" and collects every page of commits', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        res({
          body: {
            status: 'ahead',
            total_commits: 3,
            commits: [commit('c1'), commit('c2', 2, 'arun')],
          },
          headers: {
            link: '<https://api.github.com/repos/acme/ehr/compare/a...b?page=2>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(
        res({
          body: {
            status: 'ahead',
            total_commits: 3,
            commits: [commit('c3')],
          },
        }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;
    const r = await client.compareAll('acme/ehr', 'tok', 'a', 'b');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/acme/ehr/compare/a...b?per_page=100',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.github.com/repos/acme/ehr/compare/a...b?page=2',
    );
    expect(r.commits.map((c) => c.sha)).toEqual(['c1', 'c2', 'c3']);
    expect(r.commits[1]).toMatchObject({
      authorLogin: 'arun',
      parentCount: 2,
      authorEmail: 'arun@x.org',
    });
    expect(r).toMatchObject({ pages: 2, truncated: false, totalCommits: 3 });
  });

  it('compareAll returns the new commits on a diverged (force-pushed) range', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      res({
        body: {
          status: 'diverged',
          total_commits: 1,
          commits: [commit('new1')],
        },
      }),
    ) as unknown as typeof fetch;
    const r = await client.compareAll('acme/ehr', 'tok', 'old', 'new1');
    expect(r).toMatchObject({ status: 'diverged', truncated: false });
    expect(r.commits.map((c) => c.sha)).toEqual(['new1']);
  });

  it('compareAll flags truncation when GitHub returns fewer than total_commits', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      res({
        body: {
          status: 'ahead',
          total_commits: 300,
          commits: [commit('c1')],
        },
      }),
    ) as unknown as typeof fetch;
    expect(
      (await client.compareAll('acme/ehr', 'tok', 'a', 'b')).truncated,
    ).toBe(true);
  });

  it('compareAll reports not_found (e.g. a garbage-collected base) without throwing', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(res({ status: 404 })) as unknown as typeof fetch;
    const r = await client.compareAll('acme/ehr', 'tok', 'gone', 'b');
    expect(r).toMatchObject({ failure: 'not_found', commits: [] });
  });

  it('compareAll separates a rate limit from a permission refusal', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      res({
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '2000000000',
        },
      }),
    ) as unknown as typeof fetch;
    expect((await client.compareAll('acme/ehr', 'tok', 'a', 'b')).failure).toBe(
      'rate_limited',
    );
    global.fetch = jest.fn().mockResolvedValue(
      res({
        status: 403,
        headers: { 'x-ratelimit-remaining': '4000' },
      }),
    ) as unknown as typeof fetch;
    expect((await client.compareAll('acme/ehr', 'tok', 'a', 'b')).failure).toBe(
      'forbidden',
    );
  });

  it('compareAll fails rather than partially succeeding when a later page errors', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        res({
          body: {
            status: 'ahead',
            total_commits: 2,
            commits: [commit('c1')],
          },
          headers: {
            link: '<https://api.github.com/repos/acme/ehr/compare/a...b?page=2>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(res({ status: 500 })) as unknown as typeof fetch;
    const r = await client.compareAll('acme/ehr', 'tok', 'a', 'b');
    expect(r).toMatchObject({ failure: 'failed', commits: [] });
  });
});
