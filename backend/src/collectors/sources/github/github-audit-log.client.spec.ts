import {
  GithubAuditLogClient,
  buildAuditLogUrl,
  classifyForbidden,
} from './github-audit-log.client';

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
    json: async () => opts.body ?? [],
  };
}

const push = (id: string, ms: number, repo = 'acme/ehr') => ({
  '@timestamp': ms,
  _document_id: id,
  action: 'git.push',
  actor: 'dev1',
  repo,
  repository: repo,
  hashed_token: 'SECRET',
  actor_location: { country_code: 'IN' },
  user_agent: 'git/2.4',
  transport_protocol_name: 'ssh',
});

const NEXT = (cursor: string) =>
  `<https://api.github.com/organizations/1/audit-log?include=git&per_page=100&after=${cursor}&before=>; rel="next"`;

describe('buildAuditLogUrl', () => {
  it('builds the verified request with per_page=100 and the window start', () => {
    expect(
      buildAuditLogUrl(
        'athmahealth',
        new Date('2026-09-29T06:30:00.000Z'),
        100,
      ),
    ).toBe(
      'https://api.github.com/orgs/athmahealth/audit-log?include=git&phrase=action%3Agit.push%20created%3A%3E%3D2026-09-29T06%3A30%3A00%2B00%3A00&order=desc&per_page=100',
    );
  });
});

describe('classifyForbidden', () => {
  it('reads remaining=0 or retry-after as a rate limit, anything else as forbidden', () => {
    expect(
      classifyForbidden(
        res({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      ),
    ).toBe('rate_limited');
    expect(
      classifyForbidden(res({ status: 403, headers: { 'retry-after': '60' } })),
    ).toBe('rate_limited');
    expect(classifyForbidden(res({ status: 429 }))).toBe('rate_limited');
    expect(
      classifyForbidden(
        res({ status: 403, headers: { 'x-ratelimit-remaining': '1700' } }),
      ),
    ).toBe('forbidden');
  });
});

describe('GithubAuditLogClient.listGitPushes', () => {
  const client = new GithubAuditLogClient();
  const from = new Date('2026-10-06T00:00:00Z');
  afterEach(() => jest.restoreAllMocks());

  it('returns one page when there is no next link', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      res({
        body: [push('a', 1)],
        headers: { 'x-ratelimit-remaining': '1749' },
      }),
    ) as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 200);
    expect(r).toMatchObject({
      status: 'complete',
      pages: 1,
      nextTraversals: 0,
      rateLimitRemaining: 1749,
    });
    if (r.status === 'complete') {
      expect(r.events).toEqual([
        {
          documentId: 'a',
          timestamp: new Date(1),
          repoFullName: 'acme/ehr',
          actor: 'dev1',
          externalIdentityUsername: undefined,
          programmaticAccessType: undefined,
          transportProtocolName: 'ssh',
        },
      ]);
      expect(JSON.stringify(r.events)).not.toMatch(
        /SECRET|country_code|git\/2/,
      );
    }
  });

  it('follows rel="next" verbatim across pages until it is absent', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        res({ body: [push('a', 3)], headers: { link: NEXT('c1') } }),
      )
      .mockResolvedValueOnce(
        res({ body: [push('b', 2)], headers: { link: NEXT('c2') } }),
      )
      .mockResolvedValueOnce(res({ body: [push('c', 1)] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 200);
    expect(r).toMatchObject({
      status: 'complete',
      pages: 3,
      nextTraversals: 2,
    });
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.github.com/organizations/1/audit-log?include=git&per_page=100&after=c1&before=',
    );
    expect(fetchMock.mock.calls[2][0]).toContain('after=c2');
    if (r.status === 'complete')
      expect(r.events.map((e) => e.documentId)).toEqual(['a', 'b', 'c']);
  });

  it('fails the whole fetch (no partial list) when page 3 errors', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        res({ body: [push('a', 3)], headers: { link: NEXT('c1') } }),
      )
      .mockResolvedValueOnce(
        res({ body: [push('b', 2)], headers: { link: NEXT('c2') } }),
      )
      .mockResolvedValueOnce(res({ status: 502 })) as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 200);
    expect(r.status).toBe('failed');
    expect(r).not.toHaveProperty('events');
    expect(r.pages).toBe(2);
  });

  it('reports a permission 403 as forbidden with a remediation message', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        res({ status: 403, headers: { 'x-ratelimit-remaining': '1700' } }),
      ) as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 200);
    expect(r.status).toBe('forbidden');
    if (r.status !== 'complete') expect(r.message).toMatch(/read:audit_log/);
  });

  it('reports a real rate limit with its reset time', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      res({
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '2000000000',
        },
      }),
    ) as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 200);
    expect(r).toMatchObject({
      status: 'rate_limited',
      resumeAt: new Date(2_000_000_000_000),
    });
  });

  it('refuses to send the token to a next link on another origin', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(
      res({
        body: [push('a', 1)],
        headers: { link: '<https://evil.example.com/x>; rel="next"' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 200);
    expect(r.status).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails rather than stopping silently at the page ceiling', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        res({ body: [push('a', 1)], headers: { link: NEXT('again') } }),
      ) as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 2);
    expect(r).toMatchObject({ status: 'too_many_pages', pages: 2 });
  });

  it('drops entries without a document id or repo instead of inventing keys', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        res({ body: [{ action: 'git.push', '@timestamp': 1 }, push('ok', 2)] }),
      ) as unknown as typeof fetch;
    const r = await client.listGitPushes('acme', 'tok', from, 100, 200);
    if (r.status === 'complete')
      expect(r.events.map((e) => e.documentId)).toEqual(['ok']);
  });
});
