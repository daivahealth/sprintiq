import { Injectable, Logger } from '@nestjs/common';

/** One entry in an issue's change log; `items` covers every field changed together. */
export interface JiraChangelogEntry {
  id: string;
  created: string;
  author?: { accountId?: string; displayName?: string; emailAddress?: string };
  items?: {
    field?: string;
    fieldId?: string;
    fromString?: string | null;
    toString?: string | null;
  }[];
}

export interface JiraSearchIssue {
  key: string;
  fields: Record<string, unknown>;
  /**
   * Present only when the search requested `expand=changelog`. `total` is the
   * issue's full change-log length, which can exceed `histories.length` — see
   * `getIssueChangelog` for the fetch that completes a truncated one.
   */
  changelog?: {
    startAt?: number;
    maxResults?: number;
    total?: number;
    histories?: JiraChangelogEntry[];
  };
}

export interface JiraSearchPage {
  issues: JiraSearchIssue[];
  /** Present when more pages remain; pass back as `opts.pageToken` to continue. */
  nextPageToken?: string;
  /** Set when Jira signaled the token is rate-limited; caller should stop this tick. */
  rateLimitedUntil?: Date;
  /**
   * Set on any non-2xx, non-429 response (e.g. a resumed `pageToken` rejected
   * as expired because the JQL text shifted since it was issued). Callers
   * must never treat this the same as "no more pages" — an empty `issues`
   * array here means the request failed, not that the search is exhausted.
   */
  failed?: boolean;
}

export interface JiraFieldMeta {
  id: string;
  name: string;
  schema?: { custom?: string };
}

/**
 * Fields with a stable id/key across every Jira Cloud site.
 *
 * Sprint and Story Points are NOT among them — both are custom fields whose
 * numeric ids differ per site (e.g. `customfield_10020`), so they're resolved
 * via `getFields` and appended by the caller (see
 * `JiraCollector.resolveSprintFieldId` / `resolveStoryPointsFieldId`).
 *
 * Note the ids `storyPoints`, `epic`, and `epicKey` are deliberately absent:
 * they are Jira Server/classic-era names that do not exist on Cloud's v3 API,
 * which silently ignores unknown field ids rather than erroring — so
 * requesting them produced permanently-undefined values, not an error. Epic
 * linkage instead comes from `parent` (see `mapIssueToPayload`).
 */
export const BASE_SEARCH_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'project',
  'parent',
  'fixVersions',
  'assignee',
  'priority',
  'resolutiondate',
  'created',
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
      /** Adds `expand=changelog`, returning each issue's status-transition history inline. */
      withChangelog?: boolean;
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
        // Must be a comma-separated STRING — this endpoint rejects an array
        // outright with 400 "Invalid request payload".
        ...(opts.withChangelog ? { expand: 'changelog' } : {}),
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
      return { issues: [], failed: true };
    }

    const body = (await res.json()) as {
      issues?: JiraSearchIssue[];
      nextPageToken?: string;
    };
    return { issues: body.issues ?? [], nextPageToken: body.nextPageToken };
  }

  /**
   * `GET /rest/api/3/field` — used once per site to resolve the custom-field
   * ids backing Sprint and Story Points.
   *
   * Returns `null` (NOT `[]`) when the lookup fails, so callers can tell a
   * failed request apart from a site that genuinely has no such field. That
   * distinction matters: the caller caches its answer permanently, and
   * caching "not present" because of a transient 401/429 would silently
   * disable sprint/story-point collection forever.
   */
  async getFields(
    siteUrl: string,
    email: string,
    apiToken: string,
  ): Promise<JiraFieldMeta[] | null> {
    if (!apiToken) {
      return null;
    }
    const url = `${siteUrl.replace(/\/$/, '')}/rest/api/3/field`;
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      this.logger.warn(`Jira field lookup failed (${res.status})`);
      return null;
    }
    return (await res.json()) as JiraFieldMeta[];
  }

  /**
   * `GET /rest/api/3/status` — the site's status catalog, flattened to
   * `name -> statusCategory key` ("new" | "indeterminate" | "done").
   *
   * Change-log entries identify statuses by NAME only, so this is what makes a
   * transition classifiable: without it there's no way to know that entering
   * "In Development" means work started while "READY FOR ESTIMATION" doesn't.
   *
   * A name can appear more than once (statuses are per-workflow objects); the
   * first category wins, which is right for all but genuinely ambiguous names.
   * Returns `null` on failure so a transient error is never cached as "this
   * site has no statuses".
   */
  async getStatusCategories(
    siteUrl: string,
    email: string,
    apiToken: string,
  ): Promise<Record<string, string> | null> {
    if (!apiToken) {
      return null;
    }
    const url = `${siteUrl.replace(/\/$/, '')}/rest/api/3/status`;
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      this.logger.warn(`Jira status catalog fetch failed (${res.status})`);
      return null;
    }
    const list = (await res.json()) as {
      name?: string;
      statusCategory?: { key?: string };
    }[];
    const map: Record<string, string> = {};
    for (const s of list) {
      const key = s.statusCategory?.key;
      if (s.name && key && map[s.name] === undefined) {
        map[s.name] = key;
      }
    }
    return map;
  }

  /**
   * `GET /rest/api/3/issue/{key}/changelog` — completes a change log that came
   * back truncated from the search endpoint (`changelog.total` greater than the
   * entries actually returned). Only worth calling for those issues: it's one
   * request each, so using it as the primary source would be an N+1 across the
   * whole backfill.
   *
   * Returns `null` on failure so the caller can keep the partial history it
   * already has rather than mistaking a failed fetch for "no more entries".
   */
  async getIssueChangelog(
    siteUrl: string,
    email: string,
    apiToken: string,
    issueKey: string,
    maxResults = 100,
  ): Promise<JiraChangelogEntry[] | null> {
    if (!apiToken) {
      return null;
    }
    const base = `${siteUrl.replace(/\/$/, '')}/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog`;
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
    const entries: JiraChangelogEntry[] = [];
    let startAt = 0;

    // Bounded: a single issue's history is small, but never loop unbounded on
    // a paginated endpoint whose `isLast` we don't control.
    for (let page = 0; page < 10; page++) {
      const res = await fetch(
        `${base}?startAt=${startAt}&maxResults=${maxResults}`,
        {
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json',
          },
        },
      );
      if (!res.ok) {
        this.logger.warn(
          `Jira changelog fetch failed (${res.status}) for ${issueKey}`,
        );
        return null;
      }
      const body = (await res.json()) as {
        values?: JiraChangelogEntry[];
        isLast?: boolean;
      };
      entries.push(...(body.values ?? []));
      if (body.isLast !== false || (body.values ?? []).length === 0) {
        break;
      }
      startAt += maxResults;
    }
    return entries;
  }
}
