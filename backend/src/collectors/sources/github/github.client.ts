import { Injectable, Logger } from '@nestjs/common';

export interface GithubPull {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  head?: { ref?: string };
  base?: { ref?: string };
  user?: { login?: string };
}

export interface GithubCommit {
  sha: string;
  commit: {
    message: string;
    author: { name?: string; email?: string; date?: string } | null;
    // `committer.date` differs from `author.date` whenever a commit is
    // rebased, cherry-picked, or amended — both are already on the list
    // endpoint's response, no extra call needed.
    committer: { name?: string; email?: string; date?: string } | null;
  };
  author: { login?: string } | null;
}

export interface GithubRepo {
  full_name: string;
  archived: boolean;
  disabled: boolean;
}

export interface GithubCommitDetail {
  additions?: number;
  deletions?: number;
  filesChanged?: number;
  /** `commit.committer.date` — same response, no extra cost; used by the reconciler to backfill already-ingested commits. */
  committedAt?: string;
  /** Set when GitHub signaled the token is rate-limited; caller should stop this tick. */
  rateLimitedUntil?: Date;
}

/**
 * The token's remaining quota, read off every response.
 *
 * Exposed so a *background* caller can stop while there is still headroom
 * left. The hard `rateLimitedUntil` stop drains the quota to nothing, which is
 * right for the poller (it is the thing users are waiting on) but wrong for
 * bulk backfill: a reconciler that spends the last request starves the regular
 * sync for the rest of the hour.
 */
export interface GithubRateLimit {
  remaining: number;
  resetAt: Date;
}

export interface GithubPullDetail {
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /** `merged_by.login` — only on the detail response, and required for `self_merge_rate`. */
  mergedBy?: string;
  /** Set when GitHub signaled the token is rate-limited; caller should stop this tick. */
  rateLimitedUntil?: Date;
  rateLimit?: GithubRateLimit;
}

export interface GithubReview {
  externalId: string;
  reviewerLogin?: string;
  /** From GitHub's own `user.type == "Bot"`, or the `name[bot]` login convention. */
  isBot: boolean;
  /** approved | changes_requested | commented | dismissed */
  state: string;
  submittedAt: string;
  hasBody: boolean;
}

export interface GithubReviewComments {
  /** Inline comments per review id. Absent id ⇒ 0 for that review. */
  countByReviewId: Map<string, number>;
  /**
   * More than one page of comments existed. The counts are then a floor, not
   * an exact figure — fine for `rubber_stamp_rate` (which only asks "was it
   * zero") and for a p50, but it must not be presented as exact.
   */
  truncated: boolean;
  rateLimitedUntil?: Date;
  rateLimit?: GithubRateLimit;
  /** Request failed — counts are unknown, NOT zero. */
  failed?: boolean;
}

/**
 * GitHub renders App-based bots with a `name[bot]` login. `user.type` is the
 * authoritative signal, but it is absent from some payload shapes, so the
 * suffix is the documented fallback rather than the primary test.
 */
export function isBotAccount(
  login: string | undefined,
  type: string | undefined,
): boolean {
  if (type === 'Bot') {
    return true;
  }
  return typeof login === 'string' && login.endsWith('[bot]');
}

export interface GithubPullReviews {
  reviews: GithubReview[];
  /** Set when GitHub signaled the token is rate-limited; caller should stop this tick. */
  rateLimitedUntil?: Date;
  rateLimit?: GithubRateLimit;
  /**
   * The request failed (not rate-limited). Callers must not read an empty
   * `reviews` here as "this PR was merged unreviewed" — that is a real,
   * reportable finding and inventing it from a 500 would be worse than
   * reporting nothing.
   */
  failed?: boolean;
}

export interface GithubPullCommits {
  /**
   * Commit subjects on the PR, for Jira-key extraction (api/README.md §6).
   * Empty when the request failed — an empty list is indistinguishable from a
   * PR whose commits carry no key, and both correctly yield no extra match.
   */
  messages: string[];
  /** Set when GitHub signaled the token is rate-limited; caller should stop this tick. */
  rateLimitedUntil?: Date;
}

export interface GithubPage<T> {
  items: T[];
  hasNextPage: boolean;
  /** Set when GitHub signaled the token is rate-limited; caller should stop this tick. */
  rateLimitedUntil?: Date;
  /**
   * Set on any non-2xx, non-rate-limit response (revoked token, renamed or
   * deleted repo, SSO-blocked org). Callers must never read this as "no more
   * pages" — an empty `items` here means the request failed, not that the
   * history is exhausted, so concluding a backfill on it would permanently
   * mark the connection complete with nothing collected.
   */
  failed?: boolean;
}

/**
 * Typed GitHub REST client (BC-1). Owns pagination (`Link` header) and
 * rate-limit awareness (`X-RateLimit-*` headers, 403/429) so the collector
 * never talks to `fetch` directly — collectors are the only door to the
 * outside world (CLAUDE.md).
 */
@Injectable()
export class GithubClient {
  private readonly logger = new Logger(GithubClient.name);
  private readonly baseUrl = 'https://api.github.com';

  async listPullRequestsPage(
    repoFullName: string,
    token: string,
    page: number,
    perPage = 100,
  ): Promise<GithubPage<GithubPull>> {
    const url = `${this.baseUrl}/repos/${repoFullName}/pulls?state=all&sort=updated&direction=desc&per_page=${perPage}&page=${page}`;
    return this.getPage<GithubPull>(url, token);
  }

  /** `type=all` includes private repos the token can see — required for org-wide sync. */
  async listOrgReposPage(
    org: string,
    token: string,
    page: number,
    perPage = 100,
  ): Promise<GithubPage<GithubRepo>> {
    const url = `${this.baseUrl}/orgs/${org}/repos?type=all&per_page=${perPage}&page=${page}`;
    return this.getPage<GithubRepo>(url, token);
  }

  /** `since` is an ISO timestamp — GitHub's commits endpoint filters natively. */
  async listCommitsPage(
    repoFullName: string,
    token: string,
    page: number,
    since: string,
    perPage = 100,
  ): Promise<GithubPage<GithubCommit>> {
    const url = `${this.baseUrl}/repos/${repoFullName}/commits?since=${encodeURIComponent(since)}&per_page=${perPage}&page=${page}`;
    return this.getPage<GithubCommit>(url, token);
  }

  /** `GET /repos/{repo}/commits/{sha}` — the only way to get a commit's line-change stats; the list endpoint never includes them. */
  async getCommitDetail(
    repoFullName: string,
    token: string,
    sha: string,
  ): Promise<GithubCommitDetail> {
    if (!token) {
      return {};
    }
    const url = `${this.baseUrl}/repos/${repoFullName}/commits/${sha}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (res.status === 403 || res.status === 429) {
      const resetAt = this.parseResetHeader(
        res.headers.get('x-ratelimit-reset'),
      );
      this.logger.warn(`GitHub rate-limited until ${resetAt.toISOString()}`);
      return { rateLimitedUntil: resetAt };
    }
    if (!res.ok) {
      this.logger.warn(`GitHub commit detail failed (${res.status}): ${url}`);
      return {};
    }

    const body = (await res.json()) as {
      commit?: { committer?: { date?: string } | null };
      stats?: { additions?: number; deletions?: number };
      files?: unknown[];
    };
    const detail: GithubCommitDetail = {
      additions: body.stats?.additions,
      deletions: body.stats?.deletions,
      filesChanged: Array.isArray(body.files) ? body.files.length : undefined,
      committedAt: body.commit?.committer?.date,
    };

    // Same preemption as list pages: don't let the NEXT call blow past a hard 403.
    const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
    if (!Number.isNaN(remaining) && remaining <= 1) {
      detail.rateLimitedUntil = this.parseResetHeader(
        res.headers.get('x-ratelimit-reset'),
      );
    }
    return detail;
  }

  /** `GET /repos/{repo}/pulls/{number}` — the only way to get a PR's line-change stats; the list endpoint never includes them. */
  async getPullRequestDetail(
    repoFullName: string,
    token: string,
    number: number | string,
  ): Promise<GithubPullDetail> {
    if (!token) {
      return {};
    }
    const url = `${this.baseUrl}/repos/${repoFullName}/pulls/${number}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (res.status === 403 || res.status === 429) {
      const resetAt = this.parseResetHeader(
        res.headers.get('x-ratelimit-reset'),
      );
      this.logger.warn(`GitHub rate-limited until ${resetAt.toISOString()}`);
      return { rateLimitedUntil: resetAt };
    }
    if (!res.ok) {
      this.logger.warn(`GitHub PR detail failed (${res.status}): ${url}`);
      return {};
    }

    const body = (await res.json()) as {
      additions?: number;
      deletions?: number;
      changed_files?: number;
      merged_by?: { login?: string } | null;
    };
    const detail: GithubPullDetail = {
      rateLimit: this.readRateLimit(res),
      additions: body.additions,
      deletions: body.deletions,
      changedFiles: body.changed_files,
      // Same response, no extra call — `merged_by` exists only here, not on
      // the list endpoint.
      mergedBy: body.merged_by?.login,
    };

    // Same preemption as list pages: don't let the NEXT call blow past a hard 403.
    const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
    if (!Number.isNaN(remaining) && remaining <= 1) {
      detail.rateLimitedUntil = this.parseResetHeader(
        res.headers.get('x-ratelimit-reset'),
      );
    }
    return detail;
  }

  /**
   * `GET /repos/{repo}/pulls/{number}/commits` — the PR's commit subjects.
   *
   * Neither the PR list, the PR detail, nor the `pull_request` webhook payload
   * carries them, yet they are one of the three documented Jira-key sources
   * (api/README.md §6) — a PR whose key appears only in its commits is
   * otherwise a permanent orphan, dragging `linkage_coverage`.
   *
   * One page (100) is deliberate: GitHub caps this endpoint at 250 commits
   * anyway, and a PR needing more than 100 commits to mention its issue key
   * once is not the case worth a second round-trip.
   */
  async listPullRequestCommits(
    repoFullName: string,
    token: string,
    number: number | string,
  ): Promise<GithubPullCommits> {
    if (!token) {
      return { messages: [] };
    }
    const url = `${this.baseUrl}/repos/${repoFullName}/pulls/${number}/commits?per_page=100`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (res.status === 403 || res.status === 429) {
      const resetAt = this.parseResetHeader(
        res.headers.get('x-ratelimit-reset'),
      );
      this.logger.warn(`GitHub rate-limited until ${resetAt.toISOString()}`);
      return { messages: [], rateLimitedUntil: resetAt };
    }
    if (!res.ok) {
      this.logger.warn(`GitHub PR commits failed (${res.status}): ${url}`);
      return { messages: [] };
    }

    const body = (await res.json()) as { commit?: { message?: string } }[];
    const result: GithubPullCommits = {
      messages: (Array.isArray(body) ? body : [])
        .map((c) => c.commit?.message)
        .filter((m): m is string => typeof m === 'string' && m.length > 0),
    };

    // Same preemption as everywhere else: don't let the NEXT call hit a hard 403.
    const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
    if (!Number.isNaN(remaining) && remaining <= 1) {
      result.rateLimitedUntil = this.parseResetHeader(
        res.headers.get('x-ratelimit-reset'),
      );
    }
    return result;
  }

  /**
   * `GET /repos/{repo}/pulls/{number}/reviews` — the PR's submitted reviews.
   *
   * The only source for the whole Review Quality family (METRICS.md §3) and
   * for the pr_cycle_time sub-phases: neither the PR list nor the PR detail
   * carries reviews, and the pull_request webhook payload doesn't either.
   *
   * NOTE: this endpoint gives each review's state, author, timestamp and body
   * — but NOT its inline comment count. That needs
   * `GET /pulls/{n}/comments` (a further call), which is why `review_depth`
   * and `rubber_stamp_rate` stay unimplemented rather than being approximated
   * from the body (api/README.md §12).
   */
  async listPullRequestReviews(
    repoFullName: string,
    token: string,
    number: number | string,
  ): Promise<GithubPullReviews> {
    if (!token) {
      return { reviews: [] };
    }
    const url = `${this.baseUrl}/repos/${repoFullName}/pulls/${number}/reviews?per_page=100`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (res.status === 403 || res.status === 429) {
      const resetAt = this.parseResetHeader(
        res.headers.get('x-ratelimit-reset'),
      );
      this.logger.warn(`GitHub rate-limited until ${resetAt.toISOString()}`);
      return { reviews: [], rateLimitedUntil: resetAt };
    }
    if (!res.ok) {
      this.logger.warn(`GitHub PR reviews failed (${res.status}): ${url}`);
      // Flagged, not silent: "no reviews" is a reportable finding
      // (review_coverage, self_merge_rate), so a failed request must never
      // be persisted as one.
      return { reviews: [], failed: true };
    }

    const body = (await res.json()) as {
      id?: number | string;
      user?: { login?: string; type?: string } | null;
      state?: string;
      submitted_at?: string | null;
      body?: string | null;
    }[];

    const result: GithubPullReviews = {
      rateLimit: this.readRateLimit(res),
      reviews: (Array.isArray(body) ? body : [])
        .filter(
          (r) =>
            r.id !== undefined &&
            typeof r.state === 'string' &&
            // A PENDING review has never been submitted — it is the reviewer's
            // unsent draft, visible only to them, and counting it would credit
            // a review that nobody has actually received.
            r.state.toUpperCase() !== 'PENDING' &&
            typeof r.submitted_at === 'string',
        )
        .map((r) => ({
          externalId: String(r.id),
          reviewerLogin: r.user?.login,
          isBot: isBotAccount(r.user?.login, r.user?.type),
          state: (r.state as string).toLowerCase(),
          submittedAt: r.submitted_at as string,
          hasBody: typeof r.body === 'string' && r.body.trim().length > 0,
        })),
    };

    // Same preemption as everywhere else: don't let the NEXT call hit a hard 403.
    const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
    if (!Number.isNaN(remaining) && remaining <= 1) {
      result.rateLimitedUntil = this.parseResetHeader(
        res.headers.get('x-ratelimit-reset'),
      );
    }
    return result;
  }

  /**
   * `GET /repos/{repo}/pulls/{number}/comments` — the PR's inline review
   * comments, each carrying the `pull_request_review_id` it belongs to.
   *
   * This is the only source of per-review comment counts, which
   * `review_depth` and `rubber_stamp_rate` need (METRICS.md §3). The reviews
   * endpoint returns a review's summary *body*, which is a different thing —
   * "approved with no summary note" is not "approved without reading the
   * diff", and reporting one as the other would accuse teams that approve
   * tersely.
   *
   * One page (100). GitHub's `Link` header tells us when more exist, and that
   * is reported as `truncated` rather than silently undercounting: the counts
   * then bound from below, which is still exact for "was it zero" and close
   * enough for a p50.
   */
  async listPullRequestReviewComments(
    repoFullName: string,
    token: string,
    number: number | string,
  ): Promise<GithubReviewComments> {
    const empty = {
      countByReviewId: new Map<string, number>(),
      truncated: false,
    };
    if (!token) {
      return empty;
    }
    const url = `${this.baseUrl}/repos/${repoFullName}/pulls/${number}/comments?per_page=100`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (res.status === 403 || res.status === 429) {
      const resetAt = this.parseResetHeader(
        res.headers.get('x-ratelimit-reset'),
      );
      this.logger.warn(`GitHub rate-limited until ${resetAt.toISOString()}`);
      return { ...empty, rateLimitedUntil: resetAt };
    }
    if (!res.ok) {
      this.logger.warn(`GitHub PR comments failed (${res.status}): ${url}`);
      // Unknown, not zero — a failed count must never become a rubber-stamp
      // finding against the reviewer.
      return { ...empty, failed: true };
    }

    const body = (await res.json()) as {
      pull_request_review_id?: number | string | null;
    }[];
    const countByReviewId = new Map<string, number>();
    for (const comment of Array.isArray(body) ? body : []) {
      if (comment.pull_request_review_id == null) {
        continue;
      }
      const key = String(comment.pull_request_review_id);
      countByReviewId.set(key, (countByReviewId.get(key) ?? 0) + 1);
    }

    const result: GithubReviewComments = {
      rateLimit: this.readRateLimit(res),
      countByReviewId,
      truncated: this.hasNextLink(res.headers.get('link')),
    };
    const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
    if (!Number.isNaN(remaining) && remaining <= 1) {
      result.rateLimitedUntil = this.parseResetHeader(
        res.headers.get('x-ratelimit-reset'),
      );
    }
    return result;
  }

  private async getPage<T>(url: string, token: string): Promise<GithubPage<T>> {
    if (!token) {
      return { items: [], hasNextPage: false };
    }
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (res.status === 403 || res.status === 429) {
      const resetAt = this.parseResetHeader(
        res.headers.get('x-ratelimit-reset'),
      );
      this.logger.warn(`GitHub rate-limited until ${resetAt.toISOString()}`);
      return { items: [], hasNextPage: false, rateLimitedUntil: resetAt };
    }
    if (!res.ok) {
      this.logger.warn(`GitHub request failed (${res.status}): ${url}`);
      return { items: [], hasNextPage: false, failed: true };
    }

    const items = (await res.json()) as T[];
    const hasNextPage = this.hasNextLink(res.headers.get('link'));

    // Preempt a hard 403 next call: stop after this (already-fetched) page
    // rather than spending the last request and getting nothing back for it.
    const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
    if (!Number.isNaN(remaining) && remaining <= 1) {
      const resetAt = this.parseResetHeader(
        res.headers.get('x-ratelimit-reset'),
      );
      return { items, hasNextPage: false, rateLimitedUntil: resetAt };
    }

    return { items, hasNextPage };
  }

  /** `X-RateLimit-*` off any response; absent when GitHub didn't send them. */
  private readRateLimit(res: {
    headers: { get(name: string): string | null };
  }): GithubRateLimit | undefined {
    const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
    if (Number.isNaN(remaining)) {
      return undefined;
    }
    return {
      remaining,
      resetAt: this.parseResetHeader(res.headers.get('x-ratelimit-reset')),
    };
  }

  private parseResetHeader(value: string | null): Date {
    const seconds = Number(value ?? NaN);
    return Number.isNaN(seconds)
      ? new Date(Date.now() + 60_000)
      : new Date(seconds * 1000);
  }

  private hasNextLink(linkHeader: string | null): boolean {
    if (!linkHeader) {
      return false;
    }
    return linkHeader.split(',').some((part) => part.includes('rel="next"'));
  }
}
