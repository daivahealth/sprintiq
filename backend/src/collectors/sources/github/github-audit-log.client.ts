import { Injectable, Logger } from '@nestjs/common';
import { isGithubApiUrl, nextLinkUrl, redactUrl } from './github-link';

/**
 * One `git.push` from the org audit log (spec F2). Only fields seen in the live
 * response are read; network/token fields (`actor_location`, `hashed_token`,
 * `token_id`, `user_agent`) are dropped here so they can never be stored or
 * logged downstream. NOTE: GitHub sends NO ref and NO before/after SHA on this
 * event — the ref range comes from branch-tip diffing (planner).
 */
export interface GitPushAuditEvent {
  documentId: string;
  timestamp: Date;
  repoFullName: string;
  /** Who pushed. Never used for commit attribution — the commit author is. */
  actor?: string;
  externalIdentityUsername?: string;
  programmaticAccessType?: string;
  transportProtocolName?: string;
}

export type AuditFetchResult =
  | {
      status: 'complete';
      events: GitPushAuditEvent[];
      pages: number;
      nextTraversals: number;
      rateLimitRemaining?: number;
    }
  | {
      status: 'failed' | 'forbidden' | 'rate_limited' | 'too_many_pages';
      pages: number;
      message: string;
      resumeAt?: Date;
    };

interface HeaderBag {
  get(name: string): string | null;
}

export function buildAuditLogUrl(
  org: string,
  windowFrom: Date,
  pageSize: number,
): string {
  // `+00:00` rather than `Z`, matching the request verified against GitHub.
  const iso = windowFrom.toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const phrase = encodeURIComponent(`action:git.push created:>=${iso}`);
  return `https://api.github.com/orgs/${encodeURIComponent(org)}/audit-log?include=git&phrase=${phrase}&order=desc&per_page=${pageSize}`;
}

/**
 * A 403 is NOT always a rate limit (spec F8). Only an exhausted bucket or a
 * secondary limit (`retry-after`) is; everything else is a permission or SSO
 * refusal that waiting will never fix.
 */
export function classifyForbidden(res: {
  status: number;
  headers: HeaderBag;
}): 'rate_limited' | 'forbidden' {
  if (res.status === 429) return 'rate_limited';
  if (res.headers.get('retry-after')) return 'rate_limited';
  return res.headers.get('x-ratelimit-remaining') === '0'
    ? 'rate_limited'
    : 'forbidden';
}

function resetAt(headers: HeaderBag): Date {
  const retry = Number(headers.get('retry-after') ?? NaN);
  if (!Number.isNaN(retry)) return new Date(Date.now() + retry * 1000);
  const reset = Number(headers.get('x-ratelimit-reset') ?? NaN);
  return Number.isNaN(reset)
    ? new Date(Date.now() + 60_000)
    : new Date(reset * 1000);
}

function toEvent(raw: Record<string, unknown>): GitPushAuditEvent | undefined {
  const documentId =
    typeof raw._document_id === 'string' ? raw._document_id : undefined;
  const repo =
    typeof raw.repo === 'string'
      ? raw.repo
      : typeof raw.repository === 'string'
        ? raw.repository
        : undefined;
  const ms =
    typeof raw['@timestamp'] === 'number' ? raw['@timestamp'] : undefined;
  if (!documentId || !repo || ms === undefined) {
    return undefined; // no stable key or no repo: dropped, never keyed on something invented
  }
  const str = (v: unknown) =>
    typeof v === 'string' && v !== '' ? v : undefined;
  return {
    documentId,
    timestamp: new Date(ms),
    repoFullName: repo,
    actor: str(raw.actor),
    externalIdentityUsername: str(raw.external_identity_username),
    programmaticAccessType: str(raw.programmatic_access_type),
    transportProtocolName: str(raw.transport_protocol_name),
  };
}

/**
 * GitHub Organization Audit Log, REST (spec §4.1–4.2). Uses its own `audit_log`
 * rate bucket (1,750/h) and its own org-owner token — never the collector's.
 * The result is all-or-nothing: a window is only usable once the LAST page
 * (no `rel="next"`) has been read.
 */
@Injectable()
export class GithubAuditLogClient {
  private readonly logger = new Logger(GithubAuditLogClient.name);

  async listGitPushes(
    org: string,
    token: string,
    windowFrom: Date,
    pageSize: number,
    maxPages: number,
  ): Promise<AuditFetchResult> {
    const events: GitPushAuditEvent[] = [];
    let url: string | undefined = buildAuditLogUrl(org, windowFrom, pageSize);
    let pages = 0;
    let rateLimitRemaining: number | undefined;

    while (url) {
      if (pages >= maxPages) {
        return {
          status: 'too_many_pages',
          pages,
          message: `Audit log still had more pages after ${maxPages}; raise GITHUB_AUDIT_MAX_PAGES or shorten the interval.`,
        };
      }
      if (!isGithubApiUrl(url)) {
        this.logger.error(
          `Refusing audit-log next link outside api.github.com: ${redactUrl(url)}`,
        );
        return {
          status: 'failed',
          pages,
          message: 'Next link pointed outside api.github.com.',
        };
      }
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (res.status === 403 || res.status === 429) {
        const kind = classifyForbidden(res);
        return kind === 'rate_limited'
          ? {
              status: 'rate_limited',
              pages,
              message: 'Audit-log rate limit reached.',
              resumeAt: resetAt(res.headers),
            }
          : {
              status: 'forbidden',
              pages,
              message:
                'GitHub refused the audit log (403). The audit-log token must be an org-owner classic PAT with read:audit_log, SSO-authorized for the org.',
            };
      }
      if (!res.ok) {
        this.logger.warn(
          `Audit-log page failed (${res.status}): ${redactUrl(url)}`,
        );
        return {
          status: 'failed',
          pages,
          message: `Audit-log page failed with HTTP ${res.status}.`,
        };
      }
      const body = (await res.json()) as unknown;
      pages++;
      for (const raw of Array.isArray(body) ? body : []) {
        const e = toEvent(raw as Record<string, unknown>);
        if (e) events.push(e);
      }
      const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
      rateLimitRemaining = Number.isNaN(remaining)
        ? rateLimitRemaining
        : remaining;
      url = nextLinkUrl(res.headers.get('link'));
    }

    return {
      status: 'complete',
      events,
      pages,
      nextTraversals: pages - 1,
      rateLimitRemaining,
    };
  }
}
