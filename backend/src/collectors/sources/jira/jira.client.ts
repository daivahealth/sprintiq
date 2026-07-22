import { Injectable, Logger } from '@nestjs/common';

export interface JiraSearchIssue {
  key: string;
  fields: Record<string, unknown>;
}

export interface JiraSearchPage {
  issues: JiraSearchIssue[];
  /** Present when more pages remain; pass back as `opts.pageToken` to continue. */
  nextPageToken?: string;
  /** Set when Jira signaled the token is rate-limited; caller should stop this tick. */
  rateLimitedUntil?: Date;
}

export interface JiraFieldMeta {
  id: string;
  name: string;
  schema?: { custom?: string };
}

/**
 * Fields with a stable id/key across every Jira Cloud site. Sprint is NOT
 * one of these — it's always a custom field (e.g. `customfield_10020`) whose
 * numeric id differs per site, so it's resolved separately via `getFields`
 * and appended by the caller (see `JiraCollector.resolveSprintFieldId`).
 */
export const BASE_SEARCH_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'project',
  'storyPoints',
  'epic',
  'epicKey',
  'parent',
  'fixVersions',
  'assignee',
  'priority',
  'resolutiondate',
  'updated',
];

/**
 * Typed Jira Cloud REST v3 client (BC-1). Owns pagination (`nextPageToken`)
 * and rate-limit awareness (429 + `Retry-After`) so the collector never talks
 * to `fetch` directly.
 *
 * Uses the enhanced JQL search endpoint (`POST /rest/api/3/search/jql`) —
 * the classic `GET /rest/api/3/search` was fully removed by Atlassian
 * (returns 410 Gone) in favor of this token-paginated one, which no longer
 * reports a total count.
 */
@Injectable()
export class JiraClient {
  private readonly logger = new Logger(JiraClient.name);

  async searchIssues(
    siteUrl: string,
    email: string,
    apiToken: string,
    opts: {
      jql: string;
      maxResults: number;
      fields: string[];
      pageToken?: string;
    },
  ): Promise<JiraSearchPage> {
    if (!apiToken) {
      return { issues: [] };
    }
    const url = `${siteUrl.replace(/\/$/, '')}/rest/api/3/search/jql`;
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jql: opts.jql,
        maxResults: opts.maxResults,
        fields: opts.fields,
        ...(opts.pageToken ? { nextPageToken: opts.pageToken } : {}),
      }),
    });

    if (res.status === 429) {
      const retryAfterSeconds = Number(res.headers.get('retry-after') ?? 60);
      const resetAt = new Date(
        Date.now() +
          (Number.isNaN(retryAfterSeconds) ? 60 : retryAfterSeconds) * 1000,
      );
      this.logger.warn(`Jira rate-limited until ${resetAt.toISOString()}`);
      return { issues: [], rateLimitedUntil: resetAt };
    }
    if (!res.ok) {
      this.logger.warn(`Jira search failed (${res.status}): ${opts.jql}`);
      return { issues: [] };
    }

    const body = (await res.json()) as {
      issues?: JiraSearchIssue[];
      nextPageToken?: string;
    };
    return { issues: body.issues ?? [], nextPageToken: body.nextPageToken };
  }

  /** `GET /rest/api/3/field` — used once per site to resolve Sprint's custom-field id. */
  async getFields(
    siteUrl: string,
    email: string,
    apiToken: string,
  ): Promise<JiraFieldMeta[]> {
    if (!apiToken) {
      return [];
    }
    const url = `${siteUrl.replace(/\/$/, '')}/rest/api/3/field`;
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      this.logger.warn(`Jira field lookup failed (${res.status})`);
      return [];
    }
    return (await res.json()) as JiraFieldMeta[];
  }
}
