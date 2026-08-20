import { GithubGraphqlClient } from './github-graphql.client';

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

/** A healthy quota block, so tests don't trip the `remaining <= 1` preemption. */
const RATE_LIMIT = {
  cost: 1,
  remaining: 4999,
  resetAt: '2026-08-20T13:00:00.000Z',
};

function pullNode(over: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: 'Add payments',
    state: 'MERGED',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    mergedAt: '2026-08-02T00:00:00.000Z',
    additions: 10,
    deletions: 5,
    changedFiles: 2,
    headRefName: 'feat/pay',
    baseRefName: 'main',
    author: { login: 'alice', __typename: 'User' },
    mergedBy: { login: 'bob' },
    commits: {
      pageInfo: { hasNextPage: false },
      nodes: [{ commit: { message: 'PAY-1 add gateway' } }],
    },
    reviews: { pageInfo: { hasNextPage: false }, nodes: [] },
    ...over,
  };
}

function pullsBody(nodes: unknown[], pageInfo = {}) {
  return {
    data: {
      rateLimit: RATE_LIMIT,
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: 'CUR1', ...pageInfo },
          nodes,
        },
      },
    },
  };
}

describe('GithubGraphqlClient', () => {
  let client: GithubGraphqlClient;

  beforeEach(() => {
    client = new GithubGraphqlClient();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports its transport, so the collector can tell which cursors it wrote', () => {
    expect(client.mode).toBe('graphql');
  });

  // --------------------------------------------------------- partial errors

  it('treats a 200 carrying an errors[] path as failed, NOT as an empty repo', async () => {
    // The hazard ADR-0008 flags: GraphQL answers 200 with partial data, so a
    // nulled field is indistinguishable from a genuinely absent one. Reading
    // this as "no PRs" would conclude a backfill having collected nothing.
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: {
          data: { rateLimit: RATE_LIMIT, repository: null },
          errors: [
            { message: 'Resource not accessible', path: ['repository'] },
          ],
        },
      }),
    ) as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', 'tok', {
      page: 1,
    });

    expect(page.failed).toBe(true);
    expect(page.hasNextPage).toBe(false);
    expect(page.items).toEqual([]);
  });

  it('treats an errored ANCESTOR path as failing the child it contains', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: {
          data: { rateLimit: RATE_LIMIT, repository: { pullRequests: null } },
          errors: [
            { message: 'timeout', path: ['repository', 'pullRequests'] },
          ],
        },
      }),
    ) as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', 'tok', {
      page: 1,
    });

    expect(page.failed).toBe(true);
  });

  it('fails the whole response when an error carries no path to localise it to', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: {
          data: { rateLimit: RATE_LIMIT, repository: { pullRequests: null } },
          errors: [{ message: 'Something went wrong' }],
        },
      }),
    ) as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', 'tok', {
      page: 1,
    });

    expect(page.failed).toBe(true);
  });

  // ------------------------------------------------------------ 502 fallback

  it('halves the nested page size on a 502 rather than reporting an empty page', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 502 }))
      .mockResolvedValueOnce(fakeResponse({ body: pullsBody([pullNode()]) }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', 'tok', {
      page: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(page.failed).toBeUndefined();
    expect(page.items).toHaveLength(1);

    // The retry really did shrink the query, not just repeat it.
    const first = JSON.parse(fetchMock.mock.calls[0][1].body).query as string;
    const second = JSON.parse(fetchMock.mock.calls[1][1].body).query as string;
    expect(second).not.toEqual(first);
    expect(second).toContain('commits(first: 10)');
  });

  it('reports failure — never emptiness — when 502s persist to the minimum size', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(fakeResponse({ ok: false, status: 502 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', 'tok', {
      page: 1,
    });

    expect(page.failed).toBe(true);
    expect(page.items).toEqual([]);
    // 20 -> 10 -> 5, then gives up rather than looping forever.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // ------------------------------------------------------------- rate limits

  it('maps the rateLimit field onto the page, and preempts at remaining <= 1', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: {
          data: {
            rateLimit: {
              cost: 1,
              remaining: 1,
              resetAt: '2026-08-20T13:00:00.000Z',
            },
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: true, endCursor: 'CUR1' },
                nodes: [pullNode()],
              },
            },
          },
        },
      }),
    ) as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', 'tok', {
      page: 1,
    });

    expect(page.rateLimitedUntil).toEqual(new Date('2026-08-20T13:00:00.000Z'));
  });

  it('stops on a hard 403 without claiming the history is exhausted', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        ok: false,
        status: 403,
        headers: { 'x-ratelimit-reset': '1787000000' },
      }),
    ) as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', 'tok', {
      page: 1,
    });

    expect(page.rateLimitedUntil).toEqual(new Date(1787000000 * 1000));
    expect(page.failed).toBeUndefined();
  });

  // ------------------------------------------------------------- pagination

  it('returns the opaque endCursor so the walk can resume where it stopped', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: pullsBody([pullNode()], {
          hasNextPage: true,
          endCursor: 'Y3Vyc29yOnYyOpHOAA',
        }),
      }),
    ) as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', 'tok', {
      page: 1,
    });

    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe('Y3Vyc29yOnYyOpHOAA');
  });

  it('sends the cursor as `after` when resuming', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(fakeResponse({ body: pullsBody([]) }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await client.listPullRequestsPage('acme/payments', 'tok', {
      page: 4,
      cursor: 'CUR3',
    });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.variables.after).toBe('CUR3');
  });

  // ------------------------------------------------------ shape parity (REST)

  it('normalises PR state to REST vocabulary so downstream consumers see one shape', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: pullsBody([
          pullNode({ state: 'MERGED' }),
          pullNode({ number: 2, state: 'OPEN', mergedAt: null }),
        ]),
      }),
    ) as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', 'tok', {
      page: 1,
    });

    expect(page.items[0].state).toBe('closed');
    expect(page.items[0].merged_at).toBe('2026-08-02T00:00:00.000Z');
    expect(page.items[1].state).toBe('open');
    expect(page.items[1].merged_at).toBeNull();
    expect(page.items[0].user?.login).toBe('alice');
    expect(page.items[0].head?.ref).toBe('feat/pay');
  });

  it('preserves a null commit author login — §12 #22 recovers those from name/email', async () => {
    // GraphQL's `author.user.login` is null exactly where REST's verified-email
    // linkage is: defaulting it to a string would silently regress identity
    // resolution, which recovered 19.2% of commits on the reference tenant.
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: {
          data: {
            rateLimit: RATE_LIMIT,
            repository: {
              defaultBranchRef: {
                target: {
                  history: {
                    pageInfo: { hasNextPage: false, endCursor: 'C1' },
                    nodes: [
                      {
                        oid: 'abc123',
                        message: 'PAY-2 fix rounding',
                        authoredDate: '2026-08-01T00:00:00.000Z',
                        committedDate: '2026-08-01T01:00:00.000Z',
                        additions: 4,
                        deletions: 2,
                        changedFilesIfAvailable: 1,
                        author: {
                          name: 'Carol',
                          email: 'carol@example.com',
                          user: null,
                        },
                        committer: {
                          name: 'Carol',
                          email: 'carol@example.com',
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      }),
    ) as unknown as typeof fetch;

    const page = await client.listCommitsPage(
      'acme/payments',
      'tok',
      { page: 1 },
      '2026-01-01T00:00:00.000Z',
    );

    expect(page.items[0].author).toBeNull();
    expect(page.items[0].commit.author?.email).toBe('carol@example.com');
    // Distinct author/committer dates survive — a rebase moves one, not both.
    expect(page.items[0].commit.author?.date).toBe('2026-08-01T00:00:00.000Z');
    expect(page.items[0].commit.committer?.date).toBe(
      '2026-08-01T01:00:00.000Z',
    );
  });

  // ----------------------------------------------------------- bot + reviews

  it('classifies bots from __typename, the GraphQL replacement for user.type', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: pullsBody([
          pullNode({
            reviews: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  id: 'R1',
                  databaseId: 111,
                  state: 'APPROVED',
                  submittedAt: '2026-08-02T00:00:00.000Z',
                  body: 'lgtm',
                  author: { login: 'dependabot', __typename: 'Bot' },
                  comments: { totalCount: 0 },
                },
                {
                  id: 'R2',
                  databaseId: 222,
                  state: 'COMMENTED',
                  submittedAt: '2026-08-02T01:00:00.000Z',
                  body: '',
                  author: { login: 'alice', __typename: 'User' },
                  comments: { totalCount: 3 },
                },
              ],
            },
          }),
        ]),
      }),
    ) as unknown as typeof fetch;

    await client.listPullRequestsPage('acme/payments', 'tok', { page: 1 });
    const reviews = await client.listPullRequestReviews(
      'acme/payments',
      'tok',
      1,
    );

    expect(reviews.reviews.map((r) => [r.reviewerLogin, r.isBot])).toEqual([
      ['dependabot', true],
      ['alice', false],
    ]);
    expect(reviews.reviews[0].state).toBe('approved');
    expect(reviews.reviews[0].hasBody).toBe(true);
    expect(reviews.reviews[1].hasBody).toBe(false);
  });

  it('drops PENDING reviews — an unsent draft is not a review anyone received', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: pullsBody([
          pullNode({
            reviews: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  id: 'R1',
                  databaseId: 111,
                  state: 'PENDING',
                  submittedAt: null,
                  author: { login: 'alice', __typename: 'User' },
                  comments: { totalCount: 0 },
                },
              ],
            },
          }),
        ]),
      }),
    ) as unknown as typeof fetch;

    await client.listPullRequestsPage('acme/payments', 'tok', { page: 1 });
    const reviews = await client.listPullRequestReviews(
      'acme/payments',
      'tok',
      1,
    );

    expect(reviews.reviews).toEqual([]);
  });

  it('reads per-review comment counts from totalCount, retiring REST 4th call', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: pullsBody([
          pullNode({
            reviews: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  id: 'R1',
                  databaseId: 111,
                  state: 'CHANGES_REQUESTED',
                  submittedAt: '2026-08-02T00:00:00.000Z',
                  body: 'see notes',
                  author: { login: 'alice', __typename: 'User' },
                  comments: { totalCount: 7 },
                },
              ],
            },
          }),
        ]),
      }),
    ) as unknown as typeof fetch;

    await client.listPullRequestsPage('acme/payments', 'tok', { page: 1 });
    const comments = await client.listPullRequestReviewComments(
      'acme/payments',
      'tok',
      1,
    );

    expect(comments.countByReviewId.get('111')).toBe(7);
    // totalCount is exact however many review nodes came back.
    expect(comments.truncated).toBe(false);
  });

  it('flags truncation when the reviews connection has another page', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: pullsBody([
          pullNode({
            reviews: {
              pageInfo: { hasNextPage: true },
              nodes: [
                {
                  id: 'R1',
                  databaseId: 111,
                  state: 'APPROVED',
                  submittedAt: '2026-08-02T00:00:00.000Z',
                  body: 'ok',
                  author: { login: 'alice', __typename: 'User' },
                  comments: { totalCount: 1 },
                },
              ],
            },
          }),
        ]),
      }),
    ) as unknown as typeof fetch;

    await client.listPullRequestsPage('acme/payments', 'tok', { page: 1 });
    const comments = await client.listPullRequestReviewComments(
      'acme/payments',
      'tok',
      1,
    );

    expect(comments.truncated).toBe(true);
  });

  // -------------------------------------------------------------- prefetch

  it('serves the four per-PR calls from the page query, spending nothing extra', async () => {
    // This is the whole cost argument: one query, then four free reads.
    const fetchMock = jest
      .fn()
      .mockResolvedValue(fakeResponse({ body: pullsBody([pullNode()]) }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await client.listPullRequestsPage('acme/payments', 'tok', { page: 1 });
    const detail = await client.getPullRequestDetail('acme/payments', 'tok', 1);
    const commits = await client.listPullRequestCommits(
      'acme/payments',
      'tok',
      1,
    );
    const reviews = await client.listPullRequestReviews(
      'acme/payments',
      'tok',
      1,
    );
    const comments = await client.listPullRequestReviewComments(
      'acme/payments',
      'tok',
      1,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(detail.additions).toBe(10);
    expect(detail.mergedBy).toBe('bob');
    expect(commits.messages).toEqual(['PAY-1 add gateway']);
    expect(reviews.reviews).toEqual([]);
    expect(comments.countByReviewId.size).toBe(0);
  });

  it('refetches a PR the page never covered, instead of answering from nothing', async () => {
    // The reconcilers ask about arbitrary PRs. A cache miss must go to the
    // source, never return an empty-but-successful result.
    const fetchMock = jest.fn().mockResolvedValue(
      fakeResponse({
        body: {
          data: {
            rateLimit: RATE_LIMIT,
            repository: { pullRequest: pullNode({ number: 99 }) },
          },
        },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const detail = await client.getPullRequestDetail(
      'acme/payments',
      'tok',
      99,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(detail.changedFiles).toBe(2);
  });

  it('marks an unanswerable review lookup failed, never "merged unreviewed"', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ ok: false, status: 500 }));
    global.fetch = global.fetch as unknown as typeof fetch;

    const reviews = await client.listPullRequestReviews(
      'acme/payments',
      'tok',
      42,
    );

    expect(reviews.failed).toBe(true);
    expect(reviews.reviews).toEqual([]);
  });

  it('marks an unanswerable comment count failed, never zero', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: false, status: 500 }),
      ) as unknown as typeof fetch;

    const comments = await client.listPullRequestReviewComments(
      'acme/payments',
      'tok',
      42,
    );

    // Zero would become a rubber-stamp finding against a reviewer who was
    // never actually checked.
    expect(comments.failed).toBe(true);
    expect(comments.countByReviewId.size).toBe(0);
  });

  it('marks unanswerable PR commit messages failed, so the reconciler retries', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: false, status: 500 }),
      ) as unknown as typeof fetch;

    const commits = await client.listPullRequestCommits(
      'acme/payments',
      'tok',
      42,
    );

    expect(commits.failed).toBe(true);
  });

  it('serves commit stats from the commits page, no per-sha call', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      fakeResponse({
        body: {
          data: {
            rateLimit: RATE_LIMIT,
            repository: {
              defaultBranchRef: {
                target: {
                  history: {
                    pageInfo: { hasNextPage: false, endCursor: 'C1' },
                    nodes: [
                      {
                        oid: 'abc123',
                        message: 'fix',
                        authoredDate: '2026-08-01T00:00:00.000Z',
                        committedDate: '2026-08-01T01:00:00.000Z',
                        additions: 4,
                        deletions: 2,
                        changedFilesIfAvailable: 3,
                        author: { name: 'Carol', user: { login: 'carol' } },
                        committer: { name: 'Carol' },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await client.listCommitsPage(
      'acme/payments',
      'tok',
      { page: 1 },
      '2026-01-01T00:00:00.000Z',
    );
    const detail = await client.getCommitDetail(
      'acme/payments',
      'tok',
      'abc123',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(detail).toEqual({
      additions: 4,
      deletions: 2,
      filesChanged: 3,
      committedAt: '2026-08-01T01:00:00.000Z',
    });
  });

  // -------------------------------------------------------------- org sync

  it('lists org repos with archived/disabled flags intact', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: {
          data: {
            rateLimit: RATE_LIMIT,
            organization: {
              repositories: {
                pageInfo: { hasNextPage: true, endCursor: 'R1' },
                nodes: [
                  {
                    nameWithOwner: 'athmahealth/amb',
                    isArchived: false,
                    isDisabled: false,
                  },
                  {
                    nameWithOwner: 'athmahealth/old',
                    isArchived: true,
                    isDisabled: false,
                  },
                ],
              },
            },
          },
        },
      }),
    ) as unknown as typeof fetch;

    const page = await client.listOrgReposPage('athmahealth', 'tok', {
      page: 1,
    });

    expect(page.items).toEqual([
      { full_name: 'athmahealth/amb', archived: false, disabled: false },
      { full_name: 'athmahealth/old', archived: true, disabled: false },
    ]);
    expect(page.endCursor).toBe('R1');
  });

  it('fails an org listing refused by errors[] rather than shrinking the fleet', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: {
          data: { rateLimit: RATE_LIMIT, organization: null },
          errors: [{ message: 'SAML enforcement', path: ['organization'] }],
        },
      }),
    ) as unknown as typeof fetch;

    const page = await client.listOrgReposPage('athmahealth', 'tok', {
      page: 1,
    });

    expect(page.failed).toBe(true);
    expect(page.items).toEqual([]);
  });

  // ------------------------------------------------------------ blank token

  it('reads an empty repo (no default branch) as no commits, not as a failure', async () => {
    // Found live on four repos in the reference org: initialised, never
    // pushed to. Calling that `failed` badges a healthy connection as broken,
    // never completes its backfill, and leaves it permanently due.
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: {
          data: {
            rateLimit: RATE_LIMIT,
            repository: { defaultBranchRef: null },
          },
        },
      }),
    ) as unknown as typeof fetch;

    const page = await client.listCommitsPage(
      'acme/empty',
      'tok',
      { page: 1 },
      '2026-01-01T00:00:00.000Z',
    );

    expect(page.failed).toBeUndefined();
    expect(page.items).toEqual([]);
    expect(page.hasNextPage).toBe(false);
  });

  it('still fails when the repository itself could not be read', async () => {
    // The distinction the test above depends on: a null *repository* is a
    // refusal, only a null defaultBranchRef under a real repository is empty.
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        body: { data: { rateLimit: RATE_LIMIT, repository: null } },
      }),
    ) as unknown as typeof fetch;

    const page = await client.listCommitsPage(
      'acme/gone',
      'tok',
      { page: 1 },
      '2026-01-01T00:00:00.000Z',
    );

    expect(page.failed).toBe(true);
  });

  it('reports an unreadable response body as failed instead of throwing', async () => {
    // Seen live as "Unexpected end of JSON input": the status line arrived,
    // the body was truncated. res.json() rejects, and an exception escapes
    // the clean/skipped/failed contract the collector is built on.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    }) as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', 'tok', {
      page: 1,
    });

    expect(page.failed).toBe(true);
    expect(page.items).toEqual([]);
  });

  it('reports a dropped connection as failed instead of throwing', async () => {
    // Found against a live corporate egress path: fetch rejects rather than
    // returning a response. An exception escapes the collector's three-state
    // contract and aborts the tick before its cursors are persisted.
    global.fetch = jest
      .fn()
      .mockRejectedValue(
        new TypeError('terminated'),
      ) as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', 'tok', {
      page: 1,
    });

    expect(page.failed).toBe(true);
    expect(page.items).toEqual([]);
    expect(page.hasNextPage).toBe(false);
  });

  it('makes no request at all without a token', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const page = await client.listPullRequestsPage('acme/payments', '', {
      page: 1,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(page.items).toEqual([]);
    // Not `failed` — nothing was refused; there was simply nothing to ask with.
    expect(page.failed).toBeUndefined();
  });
});
