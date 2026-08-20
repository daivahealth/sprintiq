import type {
  GithubCommit,
  GithubCommitDetail,
  GithubPage,
  GithubPull,
  GithubPullCommits,
  GithubPullDetail,
  GithubPullReviews,
  GithubRepo,
  GithubReviewComments,
} from './github.client';

/**
 * Where a paged walk resumes.
 *
 * The two transports paginate incompatibly: REST takes a 1-based page number,
 * GraphQL an opaque `endCursor`. Both are carried so a connection can switch
 * modes without the collector caring which is live — see
 * `GithubSyncCursors.prGraphqlCursor` for what happens when the mode changes
 * mid-backfill and only the other one was ever persisted.
 */
export interface GithubPageRef {
  /** 1-based REST page. Under GraphQL it only distinguishes "first page" from "resume". */
  page: number;
  /** Opaque GraphQL cursor. Absent on the first page, or when REST wrote the cursors. */
  cursor?: string;
}

/**
 * The one GitHub I/O surface the collector, the reconcilers and org sync all
 * talk to (BC-1). Two implementations back it — `GithubClient` (REST) and
 * `GithubGraphqlClient` — selected once by `GITHUB_COLLECTION_MODE` and
 * injected under `GITHUB_SOURCE_CLIENT`.
 *
 * The signatures are deliberately REST's own, rather than the "fetch one
 * enriched page" shape GraphQL would prefer. That is not an oversight: the
 * collector's enrichment loop owns the mid-page resume offset, the backfill
 * floor comparison and the per-item rate-limit suspension (api/README.md §3,
 * §12 #37) — logic that took several live bugs to get right. Reshaping the
 * interface around GraphQL would have meant rewriting it.
 *
 * `GithubGraphqlClient` instead collapses the cost *behind* these signatures:
 * `listPullRequestsPage` fetches the page with every per-PR field inline (one
 * query, ~1 point, replacing ~100 REST calls) and answers the four follow-up
 * calls from a prefetch cache. The collector spends its enrich budget exactly
 * as before; only the price changes.
 */
export interface GithubSourceClient {
  /** Which transport is live. Logged on sync, and reported by the parity harness. */
  readonly mode: 'rest' | 'graphql';

  listPullRequestsPage(
    repoFullName: string,
    token: string,
    ref: GithubPageRef,
    perPage?: number,
  ): Promise<GithubPage<GithubPull>>;

  listCommitsPage(
    repoFullName: string,
    token: string,
    ref: GithubPageRef,
    since: string,
    perPage?: number,
  ): Promise<GithubPage<GithubCommit>>;

  listOrgReposPage(
    org: string,
    token: string,
    ref: GithubPageRef,
    perPage?: number,
  ): Promise<GithubPage<GithubRepo>>;

  getCommitDetail(
    repoFullName: string,
    token: string,
    sha: string,
  ): Promise<GithubCommitDetail>;

  getPullRequestDetail(
    repoFullName: string,
    token: string,
    number: number | string,
  ): Promise<GithubPullDetail>;

  listPullRequestCommits(
    repoFullName: string,
    token: string,
    number: number | string,
  ): Promise<GithubPullCommits>;

  listPullRequestReviews(
    repoFullName: string,
    token: string,
    number: number | string,
  ): Promise<GithubPullReviews>;

  listPullRequestReviewComments(
    repoFullName: string,
    token: string,
    number: number | string,
  ): Promise<GithubReviewComments>;
}

/** Nest DI token — the concrete class depends on `GITHUB_COLLECTION_MODE`. */
export const GITHUB_SOURCE_CLIENT = Symbol('GITHUB_SOURCE_CLIENT');

export type GithubCollectionMode = 'rest' | 'graphql';

/**
 * Reads the transport choice. Defaults to `rest` deliberately: ADR-0008
 * requires a parity harness pass against real data before GraphQL becomes the
 * default, chiefly for `author { user { login } }` versus REST's
 * verified-email linkage, which §12 #22's identity resolution depends on.
 */
export function collectionMode(): GithubCollectionMode {
  return process.env.GITHUB_COLLECTION_MODE === 'graphql' ? 'graphql' : 'rest';
}
