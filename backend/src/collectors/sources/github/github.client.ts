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
  };
  author: { login?: string } | null;
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
