import { Connection } from '@prisma/client';
import { EventTypes } from '../../../common/events/event-types';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { ConnectionsService } from '../../../modules/connections/connections.service';
import { CanonicalEnvelope } from '../../ingestion/canonical-envelope';
import { GithubClient } from './github.client';
import { GithubCollector } from './github.collector';
import { GithubGraphqlClient } from './github-graphql.client';
import type { GithubSourceClient } from './github-source-client';

/**
 * End-to-end harvest of a PR's commits, through the REAL transport clients
 * against a simulated GitHub (no network).
 *
 * The bug these guard (api/README.md §12 #51, second loss): GitHub returns a
 * PR's commits OLDEST-first, and the page query asked for `commits(first: N)`
 * — so once a PR outgrew N, every commit pushed afterwards sat past the cutoff
 * on every re-poll and was never fetched. `athmahealth/namah-app` PR #1431
 * (19 commits, page query falling back to nested:10) kept commits 1–14 and
 * never saw 15–19; the daily digest then named their author as inactive.
 *
 * The simulators below honour GitHub's semantics rather than echoing
 * fixtures: `first:` slices from the oldest end, `last:` from the newest,
 * `before:` pages backwards, and REST pages oldest-first and stops at 250.
 */

const REPO = 'athmahealth/namah-app';
const RATE_LIMIT = {
  cost: 1,
  remaining: 4999,
  resetAt: '2099-01-01T00:00:00.000Z',
};

interface FakePr {
  number: number;
  updatedAt: string;
  /** SHAs, oldest first — GitHub's own order for a PR's commits. */
  shas: string[];
}

function shas(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, i) => `c${from + i}`);
}

function commitNode(sha: string) {
  return {
    commit: {
      oid: sha,
      message: `NHC-1 ${sha}`,
      authoredDate: '2026-09-24T10:00:00Z',
      committedDate: '2026-09-24T10:00:00Z',
      additions: 1,
      deletions: 0,
      changedFilesIfAvailable: 1,
      author: { name: 'Dev', email: 'dev@example.com', user: { login: 'dev' } },
    },
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  const h = new Map(Object.entries(headers));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
  };
}

/**
 * A GraphQL endpoint for one repo. `rejectNestedAbove` reproduces the
 * complexity fallback: page queries asking for more nested commits than this
 * get a 502, so the client retries at nested:10 (then 5) — the shape the
 * namah-app log showed.
 */
function graphqlGithub(state: {
  prs: FakePr[];
  rejectNestedAbove?: number;
}): jest.Mock {
  return jest.fn(async (_url: string, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as {
      query: string;
      variables: Record<string, unknown>;
    };

    if (query.includes('query Commits')) {
      return jsonResponse({
        data: {
          rateLimit: RATE_LIMIT,
          repository: {
            defaultBranchRef: {
              target: {
                history: { pageInfo: { hasNextPage: false }, nodes: [] },
              },
            },
          },
        },
      });
    }

    if (query.includes('query PullCommits')) {
      // The paginated per-PR follow-up: `last: N, before: cursor`, paging
      // backwards. Cursors are the index of the first commit returned.
      const pr = state.prs.find((p) => p.number === variables.number);
      if (!pr) {
        return jsonResponse({
          data: { rateLimit: RATE_LIMIT, repository: { pullRequest: null } },
        });
      }
      const last = Number(variables.last);
      const before =
        typeof variables.before === 'string'
          ? Number(variables.before.slice(1))
          : pr.shas.length;
      const start = Math.max(0, before - last);
      return jsonResponse({
        data: {
          rateLimit: RATE_LIMIT,
          repository: {
            pullRequest: {
              commits: {
                totalCount: pr.shas.length,
                pageInfo: {
                  hasPreviousPage: start > 0,
                  startCursor: `i${start}`,
                },
                nodes: pr.shas.slice(start, before).map(commitNode),
              },
            },
          },
        },
      });
    }

    if (query.includes('query Pulls')) {
      const m = /commits\((first|last): (\d+)\)/.exec(query);
      const dir = m?.[1];
      const n = Number(m?.[2]);
      if (
        state.rejectNestedAbove !== undefined &&
        n > state.rejectNestedAbove
      ) {
        return jsonResponse({}, 502);
      }
      const nodes = state.prs.map((pr) => {
        const len = pr.shas.length;
        const slice =
          dir === 'last'
            ? pr.shas.slice(Math.max(0, len - n))
            : pr.shas.slice(0, n);
        const start = dir === 'last' ? Math.max(0, len - n) : 0;
        return {
          number: pr.number,
          title: 'Namah feature',
          state: 'OPEN',
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: pr.updatedAt,
          mergedAt: null,
          additions: 1,
          deletions: 1,
          changedFiles: 1,
          headRefName: 'feat/x',
          headRefOid: pr.shas[len - 1],
          baseRefName: '26-9-base',
          author: { login: 'dev', __typename: 'User' },
          mergedBy: null,
          commits: {
            totalCount: len,
            pageInfo: {
              hasNextPage: dir === 'first' && len > n,
              hasPreviousPage: dir === 'last' && start > 0,
              startCursor: `i${start}`,
            },
            nodes: slice.map(commitNode),
          },
          reviews: { pageInfo: { hasNextPage: false }, nodes: [] },
        };
      });
      return jsonResponse({
        data: {
          rateLimit: RATE_LIMIT,
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: 'P1' },
              nodes,
            },
          },
        },
      });
    }

    throw new Error(`unexpected GraphQL query: ${query.slice(0, 80)}`);
  });
}

/** GitHub REST for one repo: PR commits oldest-first, 100 per page, hard stop at 250. */
function restGithub(state: { prs: FakePr[] }): jest.Mock {
  const ok = (body: unknown, headers: Record<string, string> = {}) =>
    jsonResponse(body, 200, { 'x-ratelimit-remaining': '4999', ...headers });
  return jest.fn(async (url: string) => {
    const u = new URL(url);
    const path = u.pathname.replace(`/repos/${REPO}`, '');
    if (path === '/pulls') {
      return ok(
        state.prs.map((pr) => ({
          number: pr.number,
          title: 'Namah feature',
          state: 'open',
          merged_at: null,
          created_at: '2026-09-01T00:00:00Z',
          updated_at: pr.updatedAt,
          head: { ref: 'feat/x', sha: pr.shas[pr.shas.length - 1] },
          base: { ref: '26-9-base' },
          user: { login: 'dev' },
        })),
      );
    }
    if (path === '/commits') {
      return ok([]);
    }
    const m = /^\/pulls\/(\d+)(\/(commits|reviews|comments))?$/.exec(path);
    const pr = state.prs.find((p) => p.number === Number(m?.[1]));
    if (!m || !pr) {
      throw new Error(`unexpected REST url: ${url}`);
    }
    if (!m[3]) {
      return ok({ additions: 1, deletions: 1, changed_files: 1 });
    }
    if (m[3] !== 'commits') {
      return ok([]);
    }
    const perPage = Number(u.searchParams.get('per_page') ?? 30);
    const page = Number(u.searchParams.get('page') ?? 1);
    // GitHub's documented ceiling for this endpoint: 250 commits, oldest first.
    const reachable = pr.shas.slice(0, 250);
    const items = reachable.slice((page - 1) * perPage, page * perPage);
    const hasNext = page * perPage < reachable.length;
    return ok(
      items.map((sha) => ({
        sha,
        commit: {
          message: `NHC-1 ${sha}`,
          author: {
            name: 'Dev',
            email: 'dev@example.com',
            date: '2026-09-24T10:00:00Z',
          },
          committer: { date: '2026-09-24T10:00:00Z' },
        },
        author: { login: 'dev' },
      })),
      hasNext
        ? {
            link: `<https://api.github.com/repos/${REPO}/pulls/${pr.number}/commits?per_page=${perPage}&page=${page + 1}>; rel="next"`,
          }
        : {},
    );
  });
}

function connection(syncCursors: Record<string, unknown>): Connection {
  return {
    id: 'conn_namah',
    tenantId: 'tenant-a',
    sourceSystem: 'github',
    name: REPO,
    config: { repoFullName: REPO, backfillSince: '2026-06-01T00:00:00Z' },
    secretRef: 'GITHUB_TOKEN',
    webhookSecretRef: null,
    syncCursors,
    rateLimitState: {},
    status: 'active',
    lastSyncAt: null,
    syncLagSeconds: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Connection;
}

function commitShas(envelopes: CanonicalEnvelope[]): string[] {
  return envelopes
    .filter((e) => e.eventType === EventTypes.CODE_COMMIT_PUSHED)
    .map((e) => (e.data as { sha: string }).sha);
}

describe.each([
  ['graphql', () => new GithubGraphqlClient()],
  ['rest', () => new GithubClient()],
] as const)('PR commit harvest over %s', (mode, makeClient) => {
  let connections: jest.Mocked<ConnectionsService>;
  let secrets: jest.Mocked<SecretsService>;
  let client: GithubSourceClient;
  let collector: GithubCollector;
  const originalFetch = global.fetch;

  beforeEach(() => {
    connections = {
      setSyncCursors: jest.fn().mockResolvedValue(undefined),
      setRateLimitState: jest.fn().mockResolvedValue(undefined),
      setBackfillCompletedAt: jest.fn().mockResolvedValue(undefined),
      updateConfig: jest.fn().mockResolvedValue(undefined),
      setSyncHealth: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ConnectionsService>;
    secrets = {
      resolve: jest.fn().mockResolvedValue('tok'),
    } as unknown as jest.Mocked<SecretsService>;
    client = makeClient();
    collector = new GithubCollector(client, connections, secrets);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function install(prs: FakePr[], rejectNestedAbove?: number): void {
    global.fetch = (mode === 'graphql'
      ? graphqlGithub({ prs, rejectNestedAbove })
      : restGithub({ prs })) as unknown as typeof fetch;
  }

  /** Steady-state connection: backfill done, watermark just before the PR's update. */
  const steady = (prNewestSeenAt: string) => ({
    prBackfillDone: true,
    prNewestSeenAt,
    commitsCursor: '2026-09-20T00:00:00Z',
    cursorMode: mode,
  });

  async function pollOnce(cursors: Record<string, unknown>) {
    connections.setSyncCursors.mockClear();
    const result = await collector.poll(connection(cursors));
    const persisted = connections.setSyncCursors.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    return { result, persisted };
  }

  it('collects commits pushed after an earlier poll on a PR larger than one nested page (#1431 shape)', async () => {
    // Guards: `commits(first: N)` returning the OLDEST N, so commits 15–19 of
    // namah-app #1431 were never fetched on any re-poll. The page query here
    // falls back to nested:10, exactly as the collector log showed.
    const pr: FakePr = {
      number: 1431,
      updatedAt: '2026-09-24T12:00:00Z',
      shas: shas(1, 14),
    };
    install([pr], 10);

    const first = await pollOnce(steady('2026-09-23T00:00:00Z'));
    expect(new Set(commitShas(first.result.envelopes))).toEqual(
      new Set(shas(1, 14)),
    );

    // Five more commits pushed; the PR's updated_at moves.
    pr.shas = shas(1, 19);
    pr.updatedAt = '2026-09-26T12:00:00Z';
    const second = await pollOnce(first.persisted);

    const seen = commitShas(second.result.envelopes);
    for (const sha of shas(15, 19)) {
      expect(seen).toContain(sha);
    }
  });

  it('collects the newest commits of a long-lived PR without any fallback (nested:20)', async () => {
    // Guards: the same oldest-first cutoff at the full nested size — a PR of
    // 25 commits lost 21–25, then 26–30 after the next push.
    const pr: FakePr = {
      number: 77,
      updatedAt: '2026-09-24T12:00:00Z',
      shas: shas(1, 25),
    };
    install([pr]);

    const first = await pollOnce(steady('2026-09-23T00:00:00Z'));
    expect(new Set(commitShas(first.result.envelopes))).toEqual(
      new Set(shas(1, 25)),
    );

    pr.shas = shas(1, 30);
    pr.updatedAt = '2026-09-26T12:00:00Z';
    const second = await pollOnce(first.persisted);
    expect(commitShas(second.result.envelopes)).toEqual(
      expect.arrayContaining(shas(26, 30)),
    );
  });

  it('pages a PR larger than one page completely, emitting each commit exactly once', async () => {
    // Guards: a partial harvest (nested page / first REST page only) and a
    // follow-up that overlaps the nested page and double-emits a sha.
    const pr: FakePr = {
      number: 1020,
      updatedAt: '2026-09-24T12:00:00Z',
      shas: shas(1, 133),
    };
    install([pr], 10);

    const { result } = await pollOnce(steady('2026-09-23T00:00:00Z'));

    const seen = commitShas(result.envelopes);
    expect(seen).toHaveLength(133);
    expect(new Set(seen)).toEqual(new Set(shas(1, 133)));
    // Keys stay the default-branch walk's own, so the two sources converge.
    const keys = result.envelopes
      .filter((e) => e.eventType === EventTypes.CODE_COMMIT_PUSHED)
      .map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(133);
    expect(keys).toContain(`github:${REPO}:commit:c133`);
  });

  it('re-polling an unchanged PR emits nothing new', async () => {
    // Guards: harvesting newest-first must not turn every tick into a re-emit
    // of an idle PR. The watermark already covers it, so nothing is enriched.
    const pr: FakePr = {
      number: 1431,
      updatedAt: '2026-09-24T12:00:00Z',
      shas: shas(1, 19),
    };
    install([pr], 10);

    const first = await pollOnce(steady('2026-09-23T00:00:00Z'));
    expect(commitShas(first.result.envelopes)).toHaveLength(19);

    const again = await pollOnce(first.persisted);
    expect(commitShas(again.result.envelopes)).toEqual([]);
  });
});
