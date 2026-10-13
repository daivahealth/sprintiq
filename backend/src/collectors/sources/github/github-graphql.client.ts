import { Injectable, Logger } from '@nestjs/common';
import {
  GithubCommit,
  GithubCommitDetail,
  GithubPage,
  GithubPull,
  GithubPullCommitRef,
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

/** Below these a halved retry is pointless — give up and report `failed`. */
const MIN_NESTED = 5;

/**
 * The per-PR commit follow-up, for a PR whose `totalCount` exceeds the nested
 * page (§12 #51). One page of 100 older commits per request, walking
 * backwards from the nested page's `startCursor`.
 *
 * Capped because the cost lands on the sweep's PR enrich budget, one unit per
 * request: 5 pages reach 500 + nested commits, enough for every PR measured on
 * the reference tenant (the largest, `pe_platform_pkg` #1020, has 422).
 * The walk runs newest-to-oldest, so a PR over the cap loses its OLDEST
 * commits — which earlier polls of that PR already collected — never its
 * newest, and the cap is logged by repo.
 */
const PR_COMMIT_PAGE_SIZE = 100;
const PR_COMMIT_FOLLOWUP_MAX_PAGES = 5;

/**
 * Floor for the outer page. Small enough to rescue the heaviest repos
 * (measured: 25 PRs enriched returns in ~1.2s where 100 takes ~3.7s), large
 * enough that a backfill still advances meaningfully per tick.
 */
const MIN_FIRST = 10;

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
  /**
   * Set when the nested page held only the newest commits of a larger PR:
   * where the paginated follow-up resumes. Cleared once the follow-up has run,
   * so a repeat read is served from the completed list for free.
   */
  olderCommitsBefore?: string;
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
 *  - **silent nested truncation** — a nested connection returns N with a
 *    page flag and no other signal. For PR commits it is worse than a
 *    coverage gap: GitHub lists them oldest-first, so `first: N` silently
 *    dropped every commit pushed after the Nth (§12 #51). Commits are taken
 *    `last: N` and the older remainder is paged (`completeCommits`); reviews
 *    report `truncated`;
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
      (nested, first) =>
        this.post<PullsQuery>(token, this.pullsQuery(nested), {
          owner,
          name,
          first,
          after: ref.cursor ?? null,
        }),
      `PR page for ${repoFullName}`,
      perPage,
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
      byNumber.set(String(node.number), this.toPrefetched(node, repoFullName));
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
    const repository = result.data?.repository;
    if (result.failed || !repository || this.isErrored(result, 'repository')) {
      return {
        items: [],
        hasNextPage: false,
        failed: true,
        rateLimit: result.rateLimit,
      };
    }

    // A repository that resolved cleanly but has no default branch is an
    // EMPTY repo — initialised and never pushed to. That is genuinely no
    // commits, not a refused request, and the distinction runs the opposite
    // way to the usual one: reporting empty as `failed` cannot fabricate data,
    // but it badges a healthy connection as failing with a misleading
    // token-scope message, never lets its backfill complete, and so leaves it
    // permanently "due" — burning a sweep slot every tick, forever. Found on
    // four such repos in the reference org.
    if (!repository.defaultBranchRef) {
      this.logger.debug(
        `${repoFullName} has no default branch (empty repository) — reporting no commits, not a failure.`,
      );
      return { items: [], hasNextPage: false, rateLimit: result.rateLimit };
    }

    const history = repository.defaultBranchRef.target?.history;
    if (!history) {
      // A default branch whose target carries no history is not a shape GitHub
      // should return; treat it as refused rather than inventing emptiness.
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
      return this.completeCommits(repoFullName, token, number, hit);
    }
    const single = await this.fetchSinglePull(repoFullName, token, number);
    // A miss that could not be refetched is a failure, never "this PR has no
    // commit messages" — the reconciler would otherwise retire it as a
    // candidate having never actually asked.
    if (!single) {
      return { messages: [], failed: true };
    }
    return this.completeCommits(repoFullName, token, number, single);
  }

  /**
   * The PR's whole commit list: the nested page, plus — only for a PR larger
   * than it — the older remainder, paged on demand (§12 #51).
   *
   * On demand rather than inside the page query because the page prefetches
   * up to 100 PRs and the collector enriches only its budget's worth of them;
   * paging every large PR on the page would spend on PRs nobody reads.
   *
   * A completed list is written back to the prefetch entry, so a second read
   * of the same PR costs nothing. A refused or rate-limited follow-up is NOT —
   * the next reader retries it.
   */
  private async completeCommits(
    repoFullName: string,
    token: string,
    number: number | string,
    pulled: PrefetchedPull,
  ): Promise<GithubPullCommits> {
    if (!pulled.olderCommitsBefore) {
      return pulled.commits;
    }
    const completed = await this.fetchOlderCommits(
      repoFullName,
      token,
      number,
      pulled.commits,
      pulled.olderCommitsBefore,
    );
    if (!completed.failed && !completed.rateLimitedUntil) {
      pulled.commits = { ...completed, followUpRequests: undefined };
      pulled.olderCommitsBefore = undefined;
    }
    return completed;
  }

  /**
   * Pages a PR's commits backwards (`last`/`before`) from the nested page's
   * `startCursor` until the first commit, or the page cap.
   *
   * Why GraphQL here and not REST's `pulls/{n}/commits`: it keeps the
   * follow-up on the same transport, token bucket and `rateLimit` field the
   * rest of this client accounts with (REST draws on a separate 5,000 bucket
   * this client never reads); it returns stats inline, so these commits land
   * complete instead of queueing for the stats reconciler; it can walk
   * backwards from the newest page it already holds, where REST can only
   * restart from the oldest; and it is not bound by REST's 250-commit
   * ceiling. Each page is ~1 point.
   */
  private async fetchOlderCommits(
    repoFullName: string,
    token: string,
    number: number | string,
    nested: GithubPullCommits,
    startCursor: string,
  ): Promise<GithubPullCommits> {
    const [owner, name] = this.splitRepo(repoFullName);
    let before: string | undefined = startCursor;
    let older: GithubPullCommitRef[] = [];
    let requests = 0;
    let pages = 0;
    let rateLimit = nested.rateLimit;
    const finish = (extra: Partial<GithubPullCommits>): GithubPullCommits => ({
      ...this.mergeCommits(older, nested.commits ?? []),
      rateLimit,
      followUpRequests: requests,
      ...extra,
    });

    while (before && pages < PR_COMMIT_FOLLOWUP_MAX_PAGES) {
      const cursor: string = before;
      const result = await this.withComplexityFallback(
        (_nested, first) => {
          // Counted per POST, including complexity retries: the budget pays
          // for requests made, not pages received.
          requests++;
          return this.post<PullCommitsQuery>(token, PULL_COMMITS_QUERY, {
            owner,
            name,
            number: Number(number),
            last: first,
            before: cursor,
          });
        },
        `older commits of ${repoFullName} PR #${number}`,
        PR_COMMIT_PAGE_SIZE,
      );
      pages++;
      const page = result.data?.repository?.pullRequest?.commits;
      const usable =
        Boolean(page) &&
        !result.failed &&
        !this.isErrored(result, 'repository');
      if (usable && page) {
        older = [...this.toCommitRefs(page.nodes ?? []), ...older];
        before = page.pageInfo?.hasPreviousPage
          ? (page.pageInfo.startCursor ?? undefined)
          : undefined;
        rateLimit = result.rateLimit ?? rateLimit;
      }
      if (result.rateLimitedUntil) {
        // Whatever arrived is kept; the rest waits for the next reader.
        return finish({ rateLimitedUntil: result.rateLimitedUntil });
      }
      if (!usable) {
        // `failed`, with the newest commits still returned: the collector
        // emits what it holds, and a reconciler keeps the PR a candidate
        // rather than stamping it as fully asked.
        this.logger.warn(
          `${repoFullName} PR #${number}: GitHub refused the older-commit follow-up — keeping the ${nested.commits?.length ?? 0} newest commits; the rest are not collected this pass.`,
        );
        return finish({ failed: true });
      }
    }

    if (before) {
      this.logger.warn(
        `${repoFullName} PR #${number}: commit follow-up stopped at its ${PR_COMMIT_FOLLOWUP_MAX_PAGES}-page cap — the OLDEST commits beyond it are not collected from this PR (newest are).`,
      );
    } else {
      this.logger.log(
        `${repoFullName} PR #${number}: paged ${older.length} older commits beyond the nested page (${requests} extra request${requests === 1 ? '' : 's'}).`,
      );
    }
    return finish({});
  }

  /**
   * Older-then-nested, de-duplicated by sha. Order is oldest-first overall —
   * GitHub's own order — so the last entry remains the PR head, which the PR
   * commit backfill reads as `head_sha`.
   */
  private mergeCommits(
    older: GithubPullCommitRef[],
    nested: GithubPullCommitRef[],
  ): Pick<GithubPullCommits, 'messages' | 'commits'> {
    const seen = new Set<string>();
    const commits: GithubPullCommitRef[] = [];
    for (const c of [...older, ...nested]) {
      if (seen.has(c.sha)) {
        continue;
      }
      seen.add(c.sha);
      commits.push(c);
    }
    return {
      messages: commits.map((c) => c.message).filter((m) => m.length > 0),
      commits,
    };
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
      // A single PR has no outer page to shrink; only `nested` can give here.
      MIN_FIRST,
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
    const prefetched = this.toPrefetched(node, repoFullName);
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
      head: { ref: node.headRefName, sha: node.headRefOid },
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

  /**
   * Whole commits, not just subjects: the history walk reads only
   * `defaultBranchRef`, so for work merged into an integration branch this is
   * the only place the commit is ever seen. Stats come back inline here, so
   * unlike REST these land complete.
   */
  private toCommitRefs(
    nodes: ({ commit?: PullCommitNode } | null)[],
  ): GithubPullCommitRef[] {
    return nodes
      .map((c) => c?.commit)
      .filter((c): c is PullCommitNode => Boolean(c?.oid))
      .map((c) => ({
        sha: c.oid as string,
        message: c.message ?? '',
        // `author.user.login` is null when the commit email is unverified;
        // preserved rather than defaulted, so §12 #22's identity resolution
        // can still recover the person from name/email.
        authorLogin: c.author?.user?.login,
        authorName: c.author?.name,
        authorEmail: c.author?.email,
        authoredAt: c.authoredDate,
        committedAt: c.committedDate,
        additions: c.additions,
        deletions: c.deletions,
        filesChanged: c.changedFilesIfAvailable ?? undefined,
      }));
  }

  private toPrefetched(node: PullNode, repoFullName: string): PrefetchedPull {
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
      commits: this.toCommitRefs(commitNodes),
    };

    // The nested page is the NEWEST `last: N`. Anything older is recorded as
    // a resume point and paged only if this PR is actually enriched — see
    // `completeCommits`. `totalCount` is checked as well as the page flag so a
    // count the page under-reports still triggers the follow-up.
    const pageInfo = node.commits?.pageInfo;
    const totalCount = node.commits?.totalCount;
    const hasOlder =
      Boolean(pageInfo?.hasPreviousPage) ||
      (typeof totalCount === 'number' && totalCount > commitNodes.length);
    let olderCommitsBefore: string | undefined;
    if (hasOlder) {
      olderCommitsBefore = pageInfo?.startCursor ?? undefined;
      if (!olderCommitsBefore) {
        this.logger.warn(
          `${repoFullName} PR #${node.number}: ${totalCount ?? 'more'} commits but the nested page returned no cursor to page from — only the newest ${commitNodes.length} are collected from this PR.`,
        );
      }
    }

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

    return { detail, commits, reviews, comments, olderCommitsBefore };
  }

  // ------------------------------------------------------------ transport

  /**
   * Retries a 502/503/504 with a smaller query before giving up.
   *
   * ADR-0008's inverted constraint in practice: the query was too *big*, not
   * wrong. Reporting that as an empty page would read as "this repo has no
   * PRs" and, during backfill, conclude the walk.
   *
   * **The outer page count is what actually costs, not the nested one**, and
   * that was measured rather than assumed — on `athmahealth/cpoe-api`, one of
   * the two repos this fallback was failing to rescue:
   *
   * | query                  | latency |
   * |------------------------|---------|
   * | `first:100 nested:20`  | 3.68s   |
   * | `first:100 nested:5`   | 3.32s   |
   * | `first:25  nested:20`  | 1.21s   |
   *
   * Cutting nested alone buys ~10%; cutting the outer page buys ~67%. An
   * earlier version halved only `nested`, so it retried at essentially the
   * same cost and then reported failure — which is how two large repos ended
   * up permanently failing while the identical query succeeded when probed by
   * hand. Both dimensions now shrink together, outer included.
   *
   * Shrinking the outer page is safe in a way it would not be under REST:
   * GraphQL resumes from an opaque cursor, so a short page simply advances the
   * cursor less far. The walk continues next tick from exactly where it
   * stopped — no page-number arithmetic to get wrong.
   */
  private async withComplexityFallback<T>(
    run: (nested: number, first: number) => Promise<GraphqlResult<T>>,
    label: string,
    requestedFirst: number,
  ): Promise<GraphqlResult<T>> {
    let nested = Math.max(NESTED_COMMITS, NESTED_REVIEWS);
    let first = requestedFirst;
    let result = await run(nested, first);

    while (result.tooComplex && (first > MIN_FIRST || nested > MIN_NESTED)) {
      first = Math.max(MIN_FIRST, Math.floor(first / 2));
      nested = Math.max(MIN_NESTED, Math.floor(nested / 2));
      this.logger.warn(
        `GitHub GraphQL rejected ${label} as too expensive — retrying with first:${first} nested:${nested}.`,
      );
      result = await run(nested, first);
    }

    if (result.tooComplex) {
      this.logger.error(
        `GitHub GraphQL still refusing ${label} at first:${first} nested:${nested} — reporting failure, not emptiness.`,
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
    // 502/503/504 are GitHub's answers to a query it could not serve in time.
    // 504 in particular is the latency ceiling ADR-0008 predicted would become
    // binding once points stopped being scarce — seen live on a 25-PR page
    // with 20 nested commits and reviews.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return { erroredPaths: new Set(), tooComplex: true };
    }
    if (!res.ok) {
      this.logger.warn(`GitHub GraphQL request failed (${res.status})`);
      return { erroredPaths: new Set(), failed: true };
    }

    // A 200 whose body is truncated or empty throws here rather than parsing.
    // Seen live as "Unexpected end of JSON input" — the status line arrived,
    // the body did not. Same reasoning as the fetch guard above: an exception
    // is outside the collector's three-state contract and aborts the tick
    // before its cursors are written, so this becomes `failed`.
    let body: GraphqlResponse<T & { rateLimit?: RateLimitField }>;
    try {
      body = (await res.json()) as GraphqlResponse<
        T & { rateLimit?: RateLimitField }
      >;
    } catch (err) {
      this.logger.warn(
        `GitHub GraphQL returned an unreadable body: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { erroredPaths: new Set(), failed: true };
    }
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
/** A PR's commit, as both the page query and the follow-up select it. */
const PULL_COMMIT_FIELDS = `commit {
      oid
      message
      authoredDate
      committedDate
      additions
      deletions
      changedFilesIfAvailable
      author { name email user { login } }
    }`;

/**
 * Commits are `last:`, not `first:` — load-bearing (§12 #51). GitHub lists a
 * PR's commits OLDEST-first, so `first: N` returned the same oldest N on every
 * re-poll and never a commit pushed after the Nth; `withComplexityFallback`
 * halving N to 10 or 5 made that bite on ordinary PRs. `last: N` takes the
 * newest, and since incremental sync re-enriches a PR whenever its
 * `updated_at` moves, each push is collected on the next poll. `totalCount`
 * and `startCursor` feed the follow-up that pages the older remainder.
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
  headRefOid
  baseRefName
  author { login __typename }
  mergedBy { login }
  commits(last: ${nested}) {
    totalCount
    pageInfo { hasPreviousPage startCursor }
    nodes { ${PULL_COMMIT_FIELDS} }
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

/** The per-PR follow-up: one page of older commits, walking backwards. */
const PULL_COMMITS_QUERY = `
query PullCommits($owner: String!, $name: String!, $number: Int!, $last: Int!, $before: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: $last, before: $before) {
        totalCount
        pageInfo { hasPreviousPage startCursor }
        nodes { ${PULL_COMMIT_FIELDS} }
      }
    }
  }
}`;

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

/** A PR's `commits(last: N)` connection — paged backwards, hence `startCursor`. */
interface PullCommitConnection {
  totalCount?: number;
  pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null };
  nodes?: ({ commit?: PullCommitNode } | null)[];
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
  headRefOid?: string;
  baseRefName?: string;
  author?: { login?: string; __typename?: string } | null;
  mergedBy?: { login?: string } | null;
  commits?: PullCommitConnection | null;
  reviews?: { pageInfo?: PageInfo; nodes?: (ReviewNode | null)[] } | null;
}

/**
 * A commit as it appears nested under a pull request. Distinct from
 * `CommitNode` (the default-branch history walk): the fields overlap but the
 * two queries select them independently, and conflating the shapes would let a
 * change to one silently claim coverage the other never fetched.
 */
interface PullCommitNode {
  oid?: string;
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

interface PullCommitsQuery {
  repository?: {
    pullRequest?: { commits?: PullCommitConnection | null } | null;
  } | null;
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
