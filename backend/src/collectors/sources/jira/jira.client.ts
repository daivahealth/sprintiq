import { Injectable, Logger } from '@nestjs/common';

export interface JiraSearchIssue {
  key: string;
  fields: Record<string, unknown>;
}

export interface JiraSearchPage {
  issues: JiraSearchIssue[];
  total: number;
  /** Set when Jira signaled the token is rate-limited; caller should stop this tick. */
  rateLimitedUntil?: Date;
}

const SEARCH_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'project',
  'storyPoints',
  'epic',
  'epicKey',
  'parent',
  'sprint',
  'fixVersions',
  'assignee',
  'priority',
  'resolutiondate',
  'updated',
].join(',');

/**
 * Typed Jira Cloud REST v3 client (BC-1). Owns pagination (`startAt`/`total`)
 * and rate-limit awareness (429 + `Retry-After`) so the collector never talks
 * to `fetch` directly.
 */
@Injectable()
export class JiraClient {
  private readonly logger = new Logger(JiraClient.name);

  async searchIssues(
    siteUrl: string,
    email: string,
    apiToken: string,
    opts: { jql: string; startAt: number; maxResults: number },
  ): Promise<JiraSearchPage> {
    if (!apiToken) {
      return { issues: [], total: 0 };
    }
    const url =
      `${siteUrl.replace(/\/$/, '')}/rest/api/3/search` +
      `?jql=${encodeURIComponent(opts.jql)}` +
      `&startAt=${opts.startAt}&maxResults=${opts.maxResults}` +
      `&fields=${SEARCH_FIELDS}`;
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
    });

    if (res.status === 429) {
      const retryAfterSeconds = Number(res.headers.get('retry-after') ?? 60);
      const resetAt = new Date(
        Date.now() +
          (Number.isNaN(retryAfterSeconds) ? 60 : retryAfterSeconds) * 1000,
      );
      this.logger.warn(`Jira rate-limited until ${resetAt.toISOString()}`);
      return { issues: [], total: 0, rateLimitedUntil: resetAt };
    }
    if (!res.ok) {
      this.logger.warn(`Jira search failed (${res.status}): ${opts.jql}`);
      return { issues: [], total: 0 };
    }

    const body = (await res.json()) as {
      issues?: JiraSearchIssue[];
      total?: number;
    };
    return { issues: body.issues ?? [], total: body.total ?? 0 };
  }
}
