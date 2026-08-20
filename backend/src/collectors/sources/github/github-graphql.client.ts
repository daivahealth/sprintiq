import { Injectable, Logger } from '@nestjs/common';
import {
  GithubCommit,
  GithubCommitDetail,
  GithubPage,
  GithubPull,
  GithubPullCommits,
  GithubPullDetail,
  GithubPullReviews,
  GithubRateLimit,
  GithubRepo,
  GithubReview,
  GithubReviewComments,
  isBotAccount,
} from './github.client';
import type { GithubPageRef, GithubSourceClient } from './github-source-client';

/**
 * Nested collection sizes, per ADR-0008's measured ceiling.
 *
 * Complexity and latency — not points — are the binding constraint on GraphQL:
 * 25 PRs x 50 nested commits/reviews returned **502 Bad Gateway**, while 10
 * PRs x 20 nested succeeded in 9s. These are the conservative end of that
 * range, and `withComplexityFallback` halves them on a 502 rather than
 * treating the failure as an empty result.
 */
const NESTED_COMMITS = 20;
const NESTED_REVIEWS = 20;

/** Below this a halved retry is pointless — give up and report `failed`. */
const MIN_NESTED = 5;

/**
 * How long a prefetched page's enrichment stays answerable.
 *
 * The cache exists only to let the collector's four per-PR calls be served
 * from the page query that already fetched them. It is deliberately tiny and
 * short-lived: a stale answer here would be a *wrong* metric, not a slow one.
 */
const PREFETCH_TTL_MS = 5 * 60 * 1000;
/** Bounds memory at org scale — a sweep touches many repos concurrently. */
const PREFETCH_MAX_REPOS = 8;

interface PrefetchedPull {
  detail: GithubPullDetail;
  commits: GithubPullCommits;
  reviews: GithubPullReviews;
  comments: GithubReviewComments;
}

interface PrefetchEntry {
  storedAt: number;
  byNumber: Map<string, PrefetchedPull>;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: { message?: string; path?: (string | number)[] }[];
}

/** Outcome of one GraphQL POST, keeping "refused" distinct from "empty". */
interface GraphqlResult<T> {
  data?: T;
  /** Paths named in `errors[]`, joined with `.` — anything under one is NOT trustworthy. */
  erroredPaths: Set<string>;
  rateLimitedUntil?: Date;
  rateLimit?: GithubRateLimit;
  failed?: boolean;
  /** HTTP 502/503 — the query was too complex, not wrong. Caller may retry smaller. */
  tooComplex?: boolean;
}

interface RateLimitField {
  cost?: number;
  remaining?: number;
  resetAt?: string;
}

/**
 * GitHub GraphQL client (BC-1, [ADR-0008]).
 *
 * Exists because REST cannot serve a fleet at any budget: its list endpoints
 * carry none of the data the metrics need, so each PR costs 4 calls and each
 * commit 1 — ~24,765 calls for one pass over a 195-repo org against a
 * 5,000/hour limit (§12 #40). The same work here is ~1 point per page.
 *
 * It implements REST's own signatures (see `GithubSourceClient`) so the
 * collector's enrichment loop, budgets and resume cursors are untouched. The
 * saving comes from `listPullRequestsPage` fetching every per-PR field inline
 * and parking it in `prefetch`, so the four follow-up calls the collector then
 * makes cost nothing.
 *
 * Three hazards ADR-0008 flags, each handled below and each a way to
 * manufacture data that looks real:
 *  - **partial errors** — HTTP 200 with an `errors` array and partial `data`;
 *    a field nulled by an error is indistinguishable from a genuinely absent
 *    one (`erroredPaths`);
 *  - **silent nested truncation** — `commits(first: N)` returns N with
 *    `hasNextPage` and no other signal (`truncated`);
 *  - **complexity 502s** — a size problem that must not read as "no data"
 *    (`withComplexityFallback`).
 */
@Injectable()
export class GithubGraphqlClient implements GithubSourceClient {
  readonly mode = 'graphql' as const;
  private readonly logger = new Logger(GithubGraphqlClient.name);
  private readonly endpoint = 'https://api.github.com/graphql';

  /** Per-repo enrichment from the last page fetch. See `PREFETCH_TTL_MS`. */
  private readonly prefetch = new Map<string, PrefetchEntry>();

  // ---------------------------------------------------------------- pages

  /**
   * One query returns the PR page *and* every field the four REST follow-up
   * calls would have fetched. That is the whole point: ~1 point instead of
   * ~100 requests.
   */
  async listPullRequestsPage(
    repoFullName: string,
    token: string,
    ref: GithubPageRef,
    perPage = 100,
  ): Promise<GithubPage<GithubPull>> {
    if (!token) {
      return { items: [], hasNextPage: false };
    }
    const [owner, name] = this.splitRepo(repoFullName);
    if (!owner || !name) {
      this.logger.warn(`Unusable repo name "${repoFullName}"`);
      return { items: [], hasNextPage: false, failed: true };
    }

    const result = await this.withComplexityFallback(
      (nested) =>
        this.post<PullsQuery>(token, this.pullsQuery(nested), {
          owner,
          name,
          first: perPage,
          after: ref.cursor ?? null,
        }),
      `PR page for ${repoFullName}`,
    );

    if (result.rateLimitedUntil) {
      return {
        items: [],
        hasNextPage: false,
        rateLimitedUntil: result.rateLimitedUntil,
        rateLimit: result.rateLimit,
      };
    }
    // A null `pullRequests` under an errored path means "we were refused",
    // never "this repo has no PRs" — concluding a backfill on it would mark
    // the connection complete having collected nothing (§12 #29).
    const prs = result.data?.repository?.pullRequests;
    if (result.failed || !prs || this.isErrored(result, 'repository')) {
      return {
        items: [],
        hasNextPage: false,
        failed: true,
        rateLimit: result.rateLimit,
      };
    }

    const nodes = (prs.nodes ?? []).filter((n): n is PullNode => Boolean(n));
    const byNumber = new Map<string, PrefetchedPull>();
    const items: GithubPull[] = [];

    for (const node of nodes) {
      items.push(this.toPull(node));
      byNumber.set(String(node.number), this.toPrefetched(node));
    }
    this.storePrefetch(repoFullName, byNumber);

    return {
      items,
      hasNextPage: Boolean(prs.pageInfo?.hasNextPage),
      endCursor: prs.pageInfo?.endCursor ?? undefined,
      rateLimit: result.rateLimit,
    };
  }

  /**
   * Commits with `additions`/`deletions`/`changedFilesIfAvailable` inline —
   * the stats REST needs a per-commit detail call for (100 commits: 29 REST
   * calls versus 1 point here).
   */
  async listCommitsPage(
    repoFullName: string,
    token: string,
    ref: GithubPageRef,
    since: string,
    perPage = 100,
  ): Promise<GithubPage<GithubCommit>> {
    if (!token) {
      return { items: [], hasNextPage: false };
    }
    const [owner, name] = this.splitRepo(repoFullName);
    if (!owner || !name) {
      this.logger.warn(`Unusable repo name "${repoFullName}"`);
      return { items: [], hasNextPage: false, failed: true };
    }

    const result = await this.post<CommitsQuery>(token, COMMITS_QUERY, {
      owner,
      name,
      first: perPage,
      after: ref.cursor ?? null,
      since,
    });

    if (result.rateLimitedUntil) {
      return {
        items: [],
        hasNextPage: false,
        rateLimitedUntil: result.rateLimitedUntil,
        rateLimit: result.rateLimit,
      };
    }
    const history = result.data?.repository?.defaultBranchRef?.target?.history;
    if (result.failed || !history || this.isErrored(result, 'repository')) {
      return {
        items: [],
        hasNextPage: false,
        failed: true,
        rateLimit: result.rateLimit,
      };
    }

    const nodes = (history.nodes ?? []).filter((n): n is CommitNode =>
      Boolean(n),
    );
    const byShaDetail = new Map<string, GithubCommitDetail>();
    const items: GithubCommit[] = [];
    for (const node of nodes) {
      items.push(this.toCommit(node));
      byShaDetail.set(node.oid, {
        additions: node.additions,
        deletions: node.deletions,
        filesChanged: node.changedFilesIfAvailable ?? undefined,
        committedAt: node.committedDate,
      });
    }
    this.storeCommitPrefetch(repoFullName, byShaDetail);

    return {
      items,
      hasNextPage: Boolean(history.pageInfo?.hasNextPage),
      endCursor: history.pageInfo?.endCursor ?? undefined,
      rateLimit: result.rateLimit,
    };
  }

  /**
   * `type=all` equivalent: the GraphQL `repositories` connection returns both
   * public and private repos the token can see. Losing the private ones would
   * silently shrink the fleet, so `affiliations` is left unset (the default,
   * which is everything the viewer can access) rather than narrowed.
   */
  async listOrgReposPage(
    org: string,
    token: string,
    ref: GithubPageRef,
    perPage = 100,
  ): Promise<GithubPage<GithubRepo>> {
    if (!token) {
      return { items: [], hasNextPage: false };
    }
    const result = await this.post<ReposQuery>(token, REPOS_QUERY, {
      org,
      first: perPage,
      after: ref.cursor ?? null,
    });

    if (result.rateLimitedUntil) {
      return {
        items: [],
        hasNextPage: false,
        rateLimitedUntil: result.rateLimitedUntil,
        rateLimit: result.rateLimit,
      };
    }
    const repos = result.data?.organization?.repositories;
    if (result.failed || !repos || this.isErrored(result, 'organization')) {
      return {
        items: [],
        hasNextPage: false,
        failed: true,
        rateLimit: result.rateLimit,
      };
    }

    return {
      items: (repos.nodes ?? [])
        .filter((n): n is RepoNode => Boolean(n))
        .map((n) => ({
          full_name: n.nameWithOwner,
          archived: Boolean(n.isArchived),
          disabled: Boolean(n.isDisabled),
        })),
      hasNextPage: Boolean(repos.pageInfo?.hasNextPage),
      endCursor: repos.pageInfo?.endCursor ?? undefined,
      rateLimit: result.rateLimit,
    };
  }

  // ------------------------------------------------- per-item (cache-first)

  async getPullRequestDetail(
    repoFullName: string,
    token: string,
    number: number | string,
  ): Promise<GithubPullDetail> {
    const hit = this.readPrefetch(repoFullName, number);
    if (hit) {
      return hit.detail;
    }
    const single = await this.fetchSinglePull(repoFullName, token, number);
    return single?.detail ?? {};
  }

  async listPullRequestCommits(
    repoFullName: string,
    token: string,
    number: number | string,
  ): Promise<GithubPullCommits> {
    const hit = this.readPrefetch(repoFullName, number);
    if (hit) {
      return hit.commits;
    }
    const single = await this.fetchSinglePull(repoFullName, token, number);
    // A miss that could not be refetched is a failure, never "this PR has no
    // commit messages" — the reconciler would otherwise retire it as a
    // candidate having never actually asked.
    return single?.commits ?? { messages: [], failed: true };
  }

  async listPullRequestReviews(
    repoFullName: string,
    token: string,
    number: number | string,
  ): Promise<GithubPullReviews> {
    const hit = this.readPrefetch(repoFullName, number);
    if (hit) {
      return hit.reviews;
    }
    const single = await this.fetchSinglePull(repoFullName, token, number);
    // "Merged with no review" is a reportable governance finding — it must
    // never be manufactured from a failed lookup.
    return single?.reviews ?? { reviews: [], failed: true };
  }

  async listPullRequestReviewComments(
    repoFullName: string,
    token: string,
    number: number | string,
  ): Promise<GithubReviewComments> {
    const hit = this.readPrefetch(repoFullName, number);
    if (hit) {
      return hit.comments;
    }
    const single = await this.fetchSinglePull(repoFullName, token, number);
    return (
      single?.comments ?? {
        countByReviewId: new Map<string, number>(),
        truncated: false,
        // Unknown, not zero — a failed count must never become a rubber-stamp
        // finding against a reviewer.
        failed: true,
      }
    );
  }

  async getCommitDetail(
    repoFullName: string,
    token: string,
    sha: string,
  ): Promise<GithubCommitDetail> {
    const cached = this.prefetchCommits.get(repoFullName)?.byShaDetail.get(sha);
    if (cached) {
      return cached;
    }
    if (!token) {
      return {};
    }
    const [owner, name] = this.splitRepo(repoFullName);
    if (!owner || !name) {
      return {};
    }
    const result = await this.post<CommitDetailQuery>(
      token,
      COMMIT_DETAIL_QUERY,
      { owner, name, oid: sha },
    );
    if (result.rateLimitedUntil) {
      return { rateLimitedUntil: result.rateLimitedUntil };
    }
    const node = result.data?.repository?.object;
    if (!node) {
      // Matches REST's behaviour for a failed commit detail: empty stats, no
      // rate-limit claim. The commit is simply left un-enriched for a later tick.
      return {};
    }
    return {
      additions: node.additions,
      deletions: node.deletions,
      filesChanged: node.changedFilesIfAvailable ?? undefined,
      committedAt: node.committedDate,
    };
  }

  // ------------------------------------------------------------- prefetch

  /** Commit stats keyed by sha, populated by `listCommitsPage`. */
  private readonly prefetchCommits = new Map<
    string,
    { storedAt: number; byShaDetail: Map<string, GithubCommitDetail> }
  >();

  private storePrefetch(
    repoFullName: string,
    byNumber: Map<string, PrefetchedPull>,
  ): void {
    this.evictExpired();
    this.prefetch.set(repoFullName, { storedAt: Date.now(), byNumber });
    this.trim(this.prefetch);
  }

  private storeCommitPrefetch(
    repoFullName: string,
    byShaDetail: Map<string, GithubCommitDetail>,
  ): void {
    this.evictExpired();
    this.prefetchCommits.set(repoFullName, {
      storedAt: Date.now(),
      byShaDetail,
    });
    this.trim(this.prefetchCommits);
  }

  private readPrefetch(
    repoFullName: string,
    number: number | string,
  ): PrefetchedPull | undefined {
    const entry = this.prefetch.get(repoFullName);
    if (!entry || Date.now() - entry.storedAt > PREFETCH_TTL_MS) {
      return undefined;
    }
    return entry.byNumber.get(String(number));
  }

  private evictExpired(): void {
    const cutoff = Date.now() - PREFETCH_TTL_MS;
    for (const [key, entry] of this.prefetch) {
      if (entry.storedAt < cutoff) {
        this.prefetch.delete(key);
      }
    }
    for (const [key, entry] of this.prefetchCommits) {
      if (entry.storedAt < cutoff) {
        this.prefetchCommits.delete(key);
      }
    }
  }

  private trim(map: Map<string, { storedAt: number }>): void {
    while (map.size > PREFETCH_MAX_REPOS) {
      const oldest = [...map.entries()].sort(
        (a, b) => a[1].storedAt - b[1].storedAt,
      )[0];
      if (!oldest) {
        return;
      }
      map.delete(oldest[0]);
    }
  }

  /**
   * Cache miss path — the reconcilers ask about arbitrary PRs no page fetch
   * has touched. One PR, fully enriched, in one query.
   */
  private async fetchSinglePull(
    repoFullName: string,
    token: string,
    number: number | string,
  ): Promise<PrefetchedPull | undefined> {
    if (!token) {
      return undefined;
    }
    const [owner, name] = this.splitRepo(repoFullName);
    if (!owner || !name) {
      return undefined;
    }
    const result = await this.withComplexityFallback(
      (nested) =>
        this.post<SinglePullQuery>(token, this.singlePullQuery(nested), {
          owner,
          name,
          number: Number(number),
        }),
      `PR ${repoFullName}#${number}`,
    );
    if (result.rateLimitedUntil) {
      const until = result.rateLimitedUntil;
      return {
        detail: { rateLimitedUntil: until },
        commits: { messages: [], rateLimitedUntil: until },
        reviews: { reviews: [], rateLimitedUntil: until },
        comments: {
          countByReviewId: new Map(),
          truncated: false,
          rateLimitedUntil: until,
        },
      };
    }
    const node = result.data?.repository?.pullRequest;
    if (result.failed || !node || this.isErrored(result, 'repository')) {
      return undefined;
    }
    const prefetched = this.toPrefetched(node);
    prefetched.detail.rateLimit = result.rateLimit;
    return prefetched;
  }

  // -------------------------------------------------------------- mapping

  private toPull(node: PullNode): GithubPull {
    return {
      number: node.number,
      title: node.title ?? '',
      // GraphQL yields OPEN/CLOSED/MERGED; REST yields open/closed with a
      // separate merged_at. Normalised to REST's vocabulary so every
      // downstream consumer (and the parity harness) sees one shape.
      state: node.state === 'OPEN' ? 'open' : 'closed',
      merged_at: node.mergedAt ?? null,
      created_at: node.createdAt,
      updated_at: node.updatedAt,
      additions: node.additions,
      deletions: node.deletions,
      changed_files: node.changedFiles,
      head: { ref: node.headRefName },
      base: { ref: node.baseRefName },
      user: { login: node.author?.login },
    };
  }

  private toCommit(node: CommitNode): GithubCommit {
    return {
      sha: node.oid,
      commit: {
        message: node.message ?? '',
        author: {
          name: node.author?.name,
          email: node.author?.email,
          date: node.authoredDate,
        },
        committer: {
          name: node.committer?.name,
          email: node.committer?.email,
          date: node.committedDate,
        },
      },
      // `author.user.login` is GraphQL's equivalent of REST's verified-email
      // linkage: null when the commit email is not verified on an account.
      // §12 #22's identity resolution recovers those from name/email, so the
      // null must be preserved rather than defaulted.
      author: node.author?.user?.login
        ? { login: node.author.user.login }
        : null,
    };
  }

  private toPrefetched(node: PullNode): PrefetchedPull {
    const detail: GithubPullDetail = {
      additions: node.additions,
      deletions: node.deletions,
      changedFiles: node.changedFiles,
      mergedBy: node.mergedBy?.login,
    };

    const commitNodes = node.commits?.nodes ?? [];
    const commits: GithubPullCommits = {
      messages: commitNodes
        .map((c) => c?.commit?.message)
        .filter((m): m is string => typeof m === 'string' && m.length > 0),
    };

    const reviewNodes = (node.reviews?.nodes ?? []).filter(
      (r): r is ReviewNode => Boolean(r),
    );
    const reviews: GithubPullReviews = {
      reviews: reviewNodes
        .filter(
          (r) =>
            // A PENDING review is the reviewer's unsent draft — counting it
            // would credit a review nobody has received.
            typeof r.state === 'string' &&
            r.state.toUpperCase() !== 'PENDING' &&
            typeof r.submittedAt === 'string',
        )
        .map((r): GithubReview => ({
          externalId: r.databaseId != null ? String(r.databaseId) : r.id,
          reviewerLogin: r.author?.login,
          // Bot classification moves from REST's `user.type == "Bot"` to
          // `__typename`; `isBotAccount` still owns the rule, including the
          // `name[bot]` login fallback.
          isBot: isBotAccount(r.author?.login, r.author?.__typename),
          state: (r.state as string).toLowerCase(),
          submittedAt: r.submittedAt as string,
          hasBody: typeof r.body === 'string' && r.body.trim().length > 0,
        })),
    };

    // `comments { totalCount }` gives the per-review count at no node cost —
    // retiring REST's fourth per-PR call outright.
    const countByReviewId = new Map<string, number>();
    for (const r of reviewNodes) {
      const key = r.databaseId != null ? String(r.databaseId) : r.id;
      const count = r.comments?.totalCount ?? 0;
      if (count > 0) {
        countByReviewId.set(key, count);
      }
    }

    const comments: GithubReviewComments = {
      countByReviewId,
      // `totalCount` is exact regardless of how many comment nodes were
      // fetched, so counts are never truncated. The *reviews* list can be,
      // and that is reported instead.
      truncated: Boolean(node.reviews?.pageInfo?.hasNextPage),
    };

    if (node.commits?.pageInfo?.hasNextPage) {
      // Messages are a Jira-key source (§6); a truncated list can only miss a
      // key, never invent one, so this is logged rather than failed.
      this.logger.debug(
        `PR #${node.number} commit list truncated at ${commitNodes.length} — key extraction sees a subset.`,
      );
    }

    return { detail, commits, reviews, comments };
  }

  // ------------------------------------------------------------ transport

  /**
   * Retries a 502/503 with halved nested page sizes before giving up.
   *
   * ADR-0008's inverted constraint in practice: the query was too *big*, not
   * wrong. Reporting that as an empty page would read as "this repo has no
   * PRs" and, during backfill, conclude the walk.
   */
  private async withComplexityFallback<T>(
    run: (nested: number) => Promise<GraphqlResult<T>>,
    label: string,
  ): Promise<GraphqlResult<T>> {
    let nested = Math.max(NESTED_COMMITS, NESTED_REVIEWS);
    let result = await run(nested);
    while (result.tooComplex && nested > MIN_NESTED) {
      nested = Math.max(MIN_NESTED, Math.floor(nested / 2));
      this.logger.warn(
        `GitHub GraphQL 502 on ${label} — retrying with nested page size ${nested}.`,
      );
      result = await run(nested);
    }
    if (result.tooComplex) {
      this.logger.error(
        `GitHub GraphQL still failing at minimum nested size for ${label} — reporting failure, not emptiness.`,
      );
      return { ...result, failed: true };
    }
    return result;
  }

  private async post<T>(
    token: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<GraphqlResult<T>> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      // A transport-level failure — connection reset, DNS, TLS, proxy timeout —
      // throws rather than returning a response. Observed for real against a
      // corporate egress path ("SocketError: other side closed").
      //
      // It must become `failed`, not an exception: an exception escapes the
      // collector's three-state contract entirely (clean / skipped / failed),
      // aborting the tick before the cursors it was about to preserve are
      // written. `failed` keeps them and retries next tick, which is exactly
      // what a dropped connection deserves.
      this.logger.warn(
        `GitHub GraphQL request did not complete: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { erroredPaths: new Set(), failed: true };
    }

    if (res.status === 403 || res.status === 429) {
      const resetAt = this.parseResetHeader(
        res.headers.get('x-ratelimit-reset'),
      );
      this.logger.warn(
        `GitHub GraphQL rate-limited until ${resetAt.toISOString()}`,
      );
      return { erroredPaths: new Set(), rateLimitedUntil: resetAt };
    }
    // 502/503 is GitHub's answer to a query that was too expensive to serve.
    if (res.status === 502 || res.status === 503) {
      return { erroredPaths: new Set(), tooComplex: true };
    }
    if (!res.ok) {
      this.logger.warn(`GitHub GraphQL request failed (${res.status})`);
      return { erroredPaths: new Set(), failed: true };
    }

    const body = (await res.json()) as GraphqlResponse<
      T & { rateLimit?: RateLimitField }
    >;
    const rateLimit = this.readRateLimit(body.data?.rateLimit);

    // The partial-error hazard: HTTP 200, an `errors` array, and `data` with
    // holes in it. Every path named here is untrustworthy, and a null beneath
    // one must never be read as an empty collection.
    const erroredPaths = new Set<string>();
    for (const err of body.errors ?? []) {
      if (Array.isArray(err.path)) {
        erroredPaths.add(err.path.join('.'));
      }
      this.logger.warn(
        `GitHub GraphQL error${err.path ? ` at ${err.path.join('.')}` : ''}: ${err.message ?? 'unknown'}`,
      );
    }
    // Errors with no path at all cannot be localised, so nothing in the
    // response can be trusted.
    const unlocalised = (body.errors ?? []).some((e) => !Array.isArray(e.path));

    const result: GraphqlResult<T> = {
      data: body.data,
      erroredPaths,
      rateLimit,
      failed: unlocalised || undefined,
    };

    if (rateLimit && rateLimit.remaining <= 1) {
      result.rateLimitedUntil = rateLimit.resetAt;
    }
    return result;
  }

  /** True when `path` (or any ancestor of it) was named in `errors[]`. */
  private isErrored<T>(result: GraphqlResult<T>, path: string): boolean {
    for (const errored of result.erroredPaths) {
      if (errored === path || errored.startsWith(`${path}.`)) {
        return true;
      }
    }
    return false;
  }

  private readRateLimit(
    field: RateLimitField | undefined,
  ): GithubRateLimit | undefined {
    if (!field || typeof field.remaining !== 'number') {
      return undefined;
    }
    return {
      remaining: field.remaining,
      resetAt: field.resetAt
        ? new Date(field.resetAt)
        : new Date(Date.now() + 60_000),
    };
  }

  private parseResetHeader(value: string | null): Date {
    const seconds = Number(value ?? NaN);
    return Number.isNaN(seconds)
      ? new Date(Date.now() + 60_000)
      : new Date(seconds * 1000);
  }

  private splitRepo(repoFullName: string): [string?, string?] {
    const [owner, name] = repoFullName.split('/');
    return [owner || undefined, name || undefined];
  }

  // --------------------------------------------------------------- queries

  private pullsQuery(nested: number): string {
    return `
query Pulls($owner: String!, $name: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PULL_FIELDS(nested)} }
    }
  }
}`;
  }

  private singlePullQuery(nested: number): string {
    return `
query Pull($owner: String!, $name: String!, $number: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${PULL_FIELDS(nested)} }
  }
}`;
  }
}

/**
 * Every field REST needed four separate calls for: stats and `mergedBy` from
 * the detail call, commit messages, the review timeline, and per-review
 * comment counts via `totalCount`.
 */
const PULL_FIELDS = (nested: number): string => `
  number
  title
  state
  createdAt
  updatedAt
  mergedAt
  additions
  deletions
  changedFiles
  headRefName
  baseRefName
  author { login __typename }
  mergedBy { login }
  commits(first: ${nested}) {
    pageInfo { hasNextPage }
    nodes { commit { message } }
  }
  reviews(first: ${nested}) {
    pageInfo { hasNextPage }
    nodes {
      id
      databaseId
      state
      submittedAt
      body
      author { login __typename }
      comments { totalCount }
    }
  }
`;

const COMMITS_QUERY = `
query Commits($owner: String!, $name: String!, $first: Int!, $after: String, $since: GitTimestamp!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: $first, after: $after, since: $since) {
            pageInfo { hasNextPage endCursor }
            nodes {
              oid
              message
              authoredDate
              committedDate
              additions
              deletions
              changedFilesIfAvailable
              author { name email user { login } }
              committer { name email }
            }
          }
        }
      }
    }
  }
}`;

const COMMIT_DETAIL_QUERY = `
query CommitDetail($owner: String!, $name: String!, $oid: GitObjectID!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        additions
        deletions
        changedFilesIfAvailable
        committedDate
      }
    }
  }
}`;

const REPOS_QUERY = `
query Repos($org: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  organization(login: $org) {
    repositories(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { nameWithOwner isArchived isDisabled }
    }
  }
}`;

// ------------------------------------------------------------ query shapes

interface PageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}

interface ReviewNode {
  id: string;
  databaseId?: number | null;
  state?: string;
  submittedAt?: string | null;
  body?: string | null;
  author?: { login?: string; __typename?: string } | null;
  comments?: { totalCount?: number } | null;
}

interface PullNode {
  number: number;
  title?: string;
  state?: string;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  headRefName?: string;
  baseRefName?: string;
  author?: { login?: string; __typename?: string } | null;
  mergedBy?: { login?: string } | null;
  commits?: {
    pageInfo?: PageInfo;
    nodes?: ({ commit?: { message?: string } } | null)[];
  } | null;
  reviews?: { pageInfo?: PageInfo; nodes?: (ReviewNode | null)[] } | null;
}

interface CommitNode {
  oid: string;
  message?: string;
  authoredDate?: string;
  committedDate?: string;
  additions?: number;
  deletions?: number;
  changedFilesIfAvailable?: number | null;
  author?: {
    name?: string;
    email?: string;
    user?: { login?: string } | null;
  } | null;
  committer?: { name?: string; email?: string } | null;
}

interface RepoNode {
  nameWithOwner: string;
  isArchived?: boolean;
  isDisabled?: boolean;
}

interface PullsQuery {
  repository?: {
    pullRequests?: { pageInfo?: PageInfo; nodes?: (PullNode | null)[] } | null;
  } | null;
}

interface SinglePullQuery {
  repository?: { pullRequest?: PullNode | null } | null;
}

interface CommitsQuery {
  repository?: {
    defaultBranchRef?: {
      target?: {
        history?: { pageInfo?: PageInfo; nodes?: (CommitNode | null)[] } | null;
      } | null;
    } | null;
  } | null;
}

interface CommitDetailQuery {
  repository?: {
    object?: {
      additions?: number;
      deletions?: number;
      changedFilesIfAvailable?: number | null;
      committedDate?: string;
    } | null;
  } | null;
}

interface ReposQuery {
  organization?: {
    repositories?: { pageInfo?: PageInfo; nodes?: (RepoNode | null)[] } | null;
  } | null;
}
