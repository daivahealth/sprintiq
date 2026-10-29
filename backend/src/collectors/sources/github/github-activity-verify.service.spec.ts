import {
  GithubActivityVerifyService,
  LOGIN_PATTERN,
  isAttributed,
  searchStamp,
} from './github-activity-verify.service';
import { GraphqlResult } from './github-graphql.client';

type Handler = (
  vars: Record<string, unknown>,
  query: string,
) => GraphqlResult<unknown>;

const ok = (data: unknown, remaining = 4000): GraphqlResult<unknown> => ({
  data,
  erroredPaths: new Set(),
  rateLimit: { remaining, resetAt: new Date('2026-10-28T12:00:00Z') },
});

const FROM = new Date('2026-10-01T00:00:00Z');
const TO = new Date('2026-10-28T00:00:00Z');

function commitNode(
  oid: string,
  committedDate: string,
  login: string | null,
  email = 'dev@example.com',
  extra: Record<string, unknown> = {},
) {
  return {
    oid,
    message: `msg ${oid}\nbody`,
    committedDate,
    authoredDate: committedDate,
    additions: 10,
    deletions: 2,
    parents: { totalCount: 1 },
    author: { name: 'Dev', email, user: login ? { login } : null },
    ...extra,
  };
}

function build(handlers: Record<string, Handler>, repos = ['acme/api']) {
  const calls: { name: string; vars: Record<string, unknown> }[] = [];
  const gql = {
    query: jest.fn(
      async (_token: string, query: string, vars: Record<string, unknown>) => {
        const name = /query (\w+)/.exec(query)?.[1] ?? '';
        calls.push({ name, vars });
        const handler = handlers[name];
        if (!handler)
          return ok({ search: { issueCount: 0, nodes: [], pageInfo: {} } });
        return handler(vars, query);
      },
    ),
  };
  const prisma = {
    connection: {
      findMany: jest.fn(async () =>
        repos.map((repo, i) => ({
          id: `c${i}`,
          secretRef: 'ref',
          config: { repoFullName: repo },
          collectedThroughAt: i === 0 ? new Date('2026-10-27T00:00:00Z') : null,
        })),
      ),
    },
  };
  (prisma as Record<string, unknown>).githubAuditCheckpoint = {
    findUnique: jest.fn(async () => ({
      checkpointAt: new Date('2026-10-27T09:35:00Z'),
    })),
  };
  const secrets = { resolve: jest.fn(async () => 'tok') };
  const service = new GithubActivityVerifyService(
    prisma as never,
    secrets as never,
    gql as never,
  );
  return { service, calls };
}

const baseHandlers: Record<string, Handler> = {
  Users: () => ok({ u0: { id: 'U_dev', login: 'dev' } }),
  Contributed: () => ok({ user: { contributionsCollection: {} } }),
  Tips: () =>
    ok({
      repository: {
        refs: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              name: 'main',
              target: {
                __typename: 'Commit',
                committedDate: '2026-10-20T00:00:00Z',
              },
            },
            {
              name: 'feature/x',
              target: {
                __typename: 'Commit',
                committedDate: '2026-10-10T00:00:00Z',
              },
            },
            {
              name: 'stale',
              target: {
                __typename: 'Commit',
                committedDate: '2026-01-01T00:00:00Z',
              },
            },
          ],
        },
      },
    }),
};

describe('GithubActivityVerifyService.verify', () => {
  const input = {
    tenantId: 't1',
    logins: ['dev'],
    emails: ['Dev@Example.com'],
    from: FROM,
    to: TO,
    scope: 'active' as const,
    hintRepos: ['acme/api'],
  };

  it('reads every live branch whose tip is in range, skips stale ones, and applies the DB attribution rule', async () => {
    const { service, calls } = build({
      ...baseHandlers,
      Histories: (vars) => {
        const repository: Record<string, unknown> = {};
        let i = 0;
        while (`q${i}` in vars) {
          const branch = String(vars[`q${i}`]);
          const author = vars[`a${i}`] as { id?: string; emails?: string[] };
          const nodes =
            branch === 'refs/heads/feature/x' && author.id
              ? [commitNode('aaa', '2026-10-09T00:00:00Z', 'dev')]
              : branch === 'refs/heads/main' && author.emails
                ? [
                    // No account: matched by email.
                    commitNode(
                      'bbb',
                      '2026-10-05T00:00:00Z',
                      null,
                      'dev@example.com',
                    ),
                    // Same email, but GitHub resolved another account: not theirs.
                    commitNode(
                      'ccc',
                      '2026-10-05T00:00:00Z',
                      'someone-else',
                      'dev@example.com',
                    ),
                    // Outside the range by committer date.
                    commitNode(
                      'ddd',
                      '2026-09-20T00:00:00Z',
                      null,
                      'dev@example.com',
                    ),
                  ]
                : [];
          repository[`h${i}`] = {
            target: { history: { pageInfo: { hasNextPage: false }, nodes } },
          };
          i++;
        }
        return ok({ repository });
      },
    });

    const snap = await service.verify(input);

    expect(snap.commits.map((c) => c.sha).sort()).toEqual(['aaa', 'bbb']);
    expect(snap.commits.find((c) => c.sha === 'aaa')?.branches).toEqual([
      'feature/x',
    ]);
    expect(snap.coverage.branchesScanned).toBe(2);
    expect(snap.coverage.branchesSkippedInactive).toBe(1);
    expect(snap.unverified).toEqual([]);
    // Never asks the stale branch.
    const asked = calls
      .filter((c) => c.name === 'Histories')
      .flatMap((c) =>
        Object.entries(c.vars)
          .filter(([k]) => /^q\d+$/.test(k))
          .map(([, v]) => v),
      );
    expect(asked).not.toContain('refs/heads/stale');
  });

  it('reports a rate-limited run as unverified, never as an empty result', async () => {
    const { service } = build({
      ...baseHandlers,
      Tips: () => ({
        erroredPaths: new Set(),
        rateLimitedUntil: new Date('2026-10-28T13:00:00Z'),
      }),
    });

    const snap = await service.verify(input);

    expect(snap.commits).toEqual([]);
    expect(
      snap.unverified.some(
        (u) => u.kind === 'commits' && u.reason === 'rate_limited',
      ),
    ).toBe(true);
  });

  it('stops before the reserve instead of draining the token', async () => {
    const { service } = build({
      ...baseHandlers,
      Users: () => ok({ u0: { id: 'U_dev' } }, 10),
    });

    const snap = await service.verify(input);

    expect(snap.unverified.some((u) => u.reason === 'budget_reserved')).toBe(
      true,
    );
  });

  it('marks a repository GitHub cannot see as not_found', async () => {
    const { service } = build({
      ...baseHandlers,
      Tips: () => ok({ repository: null }),
    });

    const snap = await service.verify(input);

    expect(snap.unverified).toContainEqual(
      expect.objectContaining({
        kind: 'commits',
        repoFullName: 'acme/api',
        reason: 'not_found',
      }),
    );
  });

  it('collects PRs and in-range reviews, counting ones in uncollected repos separately', async () => {
    const { service } = build({
      ...baseHandlers,
      Histories: () => ok({ repository: {} }),
      PullCommits: () =>
        ok({
          repository: {
            p0: {
              commits: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    commit: commitNode(
                      'squashed',
                      '2026-10-03T00:00:00Z',
                      'dev',
                    ),
                  },
                ],
              },
            },
          },
        }),
      Search: (vars) => {
        const q = String(vars.q);
        if (q.includes('author:dev')) {
          return ok({
            search: {
              issueCount: 2,
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  __typename: 'PullRequest',
                  number: 7,
                  repository: { nameWithOwner: 'acme/api' },
                  title: 'T',
                  state: 'MERGED',
                  createdAt: '2026-10-02T00:00:00Z',
                  mergedAt: '2026-10-04T00:00:00Z',
                  additions: 5,
                  deletions: 1,
                  headRefName: 'feature/x',
                  author: { login: 'dev' },
                },
                {
                  __typename: 'PullRequest',
                  number: 3,
                  repository: { nameWithOwner: 'acme/elsewhere' },
                  title: 'U',
                  state: 'OPEN',
                  createdAt: '2026-10-02T00:00:00Z',
                  author: { login: 'dev' },
                },
              ],
            },
          });
        }
        return ok({
          search: {
            issueCount: 1,
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                __typename: 'PullRequest',
                number: 9,
                repository: { nameWithOwner: 'acme/api' },
                reviews: {
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    {
                      databaseId: 101,
                      state: 'APPROVED',
                      submittedAt: '2026-10-06T00:00:00Z',
                      author: { __typename: 'User', login: 'dev' },
                    },
                    {
                      databaseId: 102,
                      state: 'COMMENTED',
                      submittedAt: '2026-09-01T00:00:00Z',
                      author: { __typename: 'User', login: 'dev' },
                    },
                    {
                      databaseId: 103,
                      state: 'PENDING',
                      submittedAt: null,
                      author: { __typename: 'User', login: 'dev' },
                    },
                  ],
                },
              },
            ],
          },
        });
      },
    });

    const snap = await service.verify(input);

    expect(snap.pullRequests).toEqual([
      expect.objectContaining({
        repoFullName: 'acme/api',
        number: '7',
        state: 'merged',
      }),
    ]);
    expect(snap.coverage.pullRequestsOutsideCollectedRepos).toBe(1);
    expect(snap.reviews.map((r) => r.externalId)).toEqual(['101']);
    // A squash-merged PR's commits are found through the PR's own list.
    expect(snap.commits).toContainEqual(
      expect.objectContaining({
        sha: 'squashed',
        pullRequests: ['acme/api#7'],
      }),
    );
  });
});

describe('GithubActivityVerifyService — renamed repositories', () => {
  it('maps GitHub’s current name back to the collected one, and reports each repo’s sync watermark', async () => {
    const { service } = build(
      {
        ...baseHandlers,
        Histories: () => ok({ repository: {} }),
        PullCommits: () => ok({ repository: {} }),
        RepoNames: () =>
          ok({
            r0: { nameWithOwner: 'acme/api-v2' },
            r1: { nameWithOwner: 'Acme/Web' },
          }),
        Search: (vars) =>
          String(vars.q).includes('author:dev')
            ? ok({
                search: {
                  issueCount: 1,
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    {
                      __typename: 'PullRequest',
                      number: 7,
                      repository: { nameWithOwner: 'acme/api-v2' },
                      title: 'T',
                      state: 'OPEN',
                      createdAt: '2026-10-02T00:00:00Z',
                      author: { login: 'dev' },
                    },
                  ],
                },
              })
            : ok({ search: { issueCount: 0, pageInfo: {}, nodes: [] } }),
      },
      ['acme/api', 'acme/web'],
    );

    const snap = await service.verify({
      tenantId: 't1',
      logins: ['dev'],
      emails: [],
      from: FROM,
      to: TO,
      scope: 'active',
    });

    expect(snap.pullRequests).toEqual([
      expect.objectContaining({ repoFullName: 'acme/api', number: '7' }),
    ]);
    expect(snap.coverage.pullRequestsOutsideCollectedRepos).toBe(0);
    expect(snap.coverage.renamedRepos).toEqual([
      { collected: 'acme/api', current: 'acme/api-v2' },
      { collected: 'acme/web', current: 'Acme/Web' },
    ]);
    expect(snap.coverage.collectedThrough).toEqual({
      'acme/api': '2026-10-27T00:00:00.000Z',
      'acme/web': null,
    });
    expect(snap.coverage.branchCommitsCollectedThrough).toBe(
      '2026-10-27T09:35:00.000Z',
    );
  });
});

describe('GithubActivityVerifyService.lookupCommits', () => {
  it('separates found, not found and errored commits', async () => {
    const { service } = build({
      Lookup: () => ({
        ...ok({
          repository: {
            c0: {
              __typename: 'Commit',
              ...commitNode('aaa', '2026-10-09T00:00:00Z', 'dev'),
            },
            c1: null,
            c2: null,
          },
        }),
        erroredPaths: new Set(['repository.c2']),
      }),
    });

    const out = await service.lookupCommits('t1', [
      { repoFullName: 'acme/api', sha: 'aaa' },
      { repoFullName: 'acme/api', sha: 'bbb' },
      { repoFullName: 'acme/api', sha: 'ccc' },
    ]);

    expect(out.map((o) => [o.sha, o.status])).toEqual([
      ['aaa', 'found'],
      ['bbb', 'not_found'],
      ['ccc', 'unverified'],
    ]);
  });
});

describe('helpers', () => {
  it('isAttributed: a login outranks the email', () => {
    const logins = new Set(['dev']);
    const emails = new Set(['dev@example.com']);
    expect(isAttributed({ authorLogin: 'dev' }, logins, emails)).toBe(true);
    expect(
      isAttributed(
        { authorLogin: 'other', authorEmail: 'dev@example.com' },
        logins,
        emails,
      ),
    ).toBe(false);
    expect(
      isAttributed({ authorEmail: 'DEV@example.com' }, logins, emails),
    ).toBe(true);
  });

  it('accepts Enterprise Managed User logins and rejects search syntax', () => {
    expect(LOGIN_PATTERN.test('Rakesh-R_athma')).toBe(true);
    expect(LOGIN_PATTERN.test('dev')).toBe(true);
    expect(LOGIN_PATTERN.test('dev org:other')).toBe(false);
    expect(LOGIN_PATTERN.test('dev"')).toBe(false);
    expect(LOGIN_PATTERN.test('-dev')).toBe(false);
  });

  it('searchStamp drops milliseconds', () => {
    expect(searchStamp(new Date('2026-10-01T05:30:00.123Z'))).toBe(
      '2026-10-01T05:30:00Z',
    );
  });
});
