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

export interface GithubPullDetail {
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /** Set when GitHub signaled the token is rate-limited; caller should stop this tick. */
  rateLimitedUntil?: Date;
}

export interface GithubPage<T> {
  items: T[];
  hasNextPage: boolean;
  /** Set when GitHub signaled the token is rate-limited; caller should stop this tick. */
  rateLimitedUntil?: Date;
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
    };
    const detail: GithubPullDetail = {
      additions: body.additions,
      deletions: body.deletions,
      changedFiles: body.changed_files,
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
      return { items: [], hasNextPage: false };
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
