import { Injectable, Logger } from '@nestjs/common';

export interface GithubPull {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  created_at: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  head?: { ref?: string };
  base?: { ref?: string };
  user?: { login?: string };
}

/**
 * Minimal typed GitHub API client (BC-1). Only the calls the poller needs.
 * Pagination/rate-limit/backoff hardening is added as the collector matures;
 * this keeps the slice runnable when a token is configured.
 */
@Injectable()
export class GithubClient {
  private readonly logger = new Logger(GithubClient.name);
  private readonly baseUrl = 'https://api.github.com';

  async listRecentPullRequests(
    repoFullName: string,
    token: string,
  ): Promise<GithubPull[]> {
    if (!token) {
      this.logger.debug(`No token for ${repoFullName}; skipping poll.`);
      return [];
    }
    const url = `${this.baseUrl}/repos/${repoFullName}/pulls?state=all&sort=updated&direction=desc&per_page=50`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      this.logger.warn(`GitHub poll ${repoFullName} failed: ${res.status}`);
      return [];
    }
    return (await res.json()) as GithubPull[];
  }
}
