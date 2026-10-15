import { Injectable, Logger } from '@nestjs/common';
import { gunzipSync } from 'node:zlib';

/**
 * The API version GitHub documents the usage-metrics report endpoints under.
 * The rest of the collector pins 2022-11-28; these endpoints are newer than
 * that version, so they carry their own.
 */
export const COPILOT_METRICS_API_VERSION = '2026-03-10';

/**
 * The only host a report download is allowed to reach. The API hands back
 * signed URLs, and a URL taken from a response is still a URL taken from
 * outside: fetching whatever it names would let a spoofed or compromised
 * response point the collector at an internal address. GitHub moved reports
 * to this domain in May 2026 (from `copilot-reports-*.b01.azurefd.net`); if
 * it moves again the download fails closed with the host in the log, rather
 * than following it silently.
 */
export const COPILOT_REPORT_HOST = 'copilot-reports.github.com';

/** Seat pages walked per sync — 50 × 100 seats, far past any one org's size. */
const SEAT_PAGE_LIMIT = 50;

export type CopilotFailure = 'forbidden' | 'not_found' | 'error';

export type CopilotDayReport =
  | { status: 'ok'; links: string[]; reportDay: string }
  /** 204: GitHub hasn't produced that day's report yet (~2 days' latency). */
  | { status: 'not_ready' }
  | { status: 'rate_limited'; resetAt: Date }
  | { status: CopilotFailure; httpStatus: number };

export type CopilotDownload =
  | { status: 'ok'; records: Record<string, unknown>[]; malformedLines: number }
  | { status: 'error'; reason: string };

/** The fields SprintIQ reads off one entry of the seats list. */
export interface GithubCopilotSeat {
  assignee?: { login?: string; id?: number; type?: string } | null;
  created_at?: string | null;
  last_activity_at?: string | null;
  last_activity_editor?: string | null;
  pending_cancellation_date?: string | null;
}

export type CopilotSeatList =
  | { status: 'ok'; seats: GithubCopilotSeat[]; truncated: boolean }
  | { status: 'rate_limited'; resetAt: Date }
  | { status: CopilotFailure; httpStatus: number };

/**
 * GitHub's Copilot usage-metrics and seat endpoints (BC-1, ADR-0012). The only
 * code that talks to them — everything it returns goes through the ingestion
 * pipeline via `GithubCopilotUsageSyncService`.
 *
 * - `GET /orgs/{org}/copilot/metrics/reports/users-1-day?day=` returns signed
 *   download links to an NDJSON report, one record per user active that day.
 * - `GET /orgs/{org}/copilot/billing/seats` lists assigned seats, which is the
 *   only way to tell "has a seat, didn't use it" from "has no seat".
 *
 * A blank token never makes a request. The token is never logged, and a
 * signed download URL is logged without its query string (the signature).
 */
@Injectable()
export class GithubCopilotMetricsClient {
  private readonly logger = new Logger(GithubCopilotMetricsClient.name);
  private readonly baseUrl = 'https://api.github.com';

  async getUsersDayReport(
    org: string,
    day: string,
    token: string,
  ): Promise<CopilotDayReport> {
    if (!token) {
      return { status: 'forbidden', httpStatus: 0 };
    }
    const url = `${this.baseUrl}/orgs/${encodeURIComponent(org)}/copilot/metrics/reports/users-1-day?day=${encodeURIComponent(day)}`;
    const res = await fetch(url, { headers: this.headers(token) });

    if (res.status === 204) {
      return { status: 'not_ready' };
    }
    const limited = this.rateLimited(res);
    if (limited) {
      return limited;
    }
    if (!res.ok) {
      this.logger.warn(
        `Copilot users-1-day report for "${org}" ${day} failed (${res.status})`,
      );
      return { status: failureFor(res.status), httpStatus: res.status };
    }
    const body = (await res.json()) as {
      download_links?: unknown;
      report_day?: unknown;
    };
    const links = Array.isArray(body.download_links)
      ? body.download_links.filter((l): l is string => typeof l === 'string')
      : [];
    return {
      status: 'ok',
      links,
      reportDay: typeof body.report_day === 'string' ? body.report_day : day,
    };
  }

  /**
   * Fetches one signed report file. Sends **no** `Authorization` header: the
   * URL carries its own signature, and the GitHub token has no business
   * travelling to a download host.
   */
  async downloadReport(url: string): Promise<CopilotDownload> {
    if (!isAllowedReportUrl(url)) {
      this.logger.warn(
        `Refused Copilot report download from an unexpected host: ${redactQuery(url)}`,
      );
      return { status: 'error', reason: 'unexpected_host' };
    }
    const res = await fetch(url);
    if (!res.ok) {
      this.logger.warn(
        `Copilot report download failed (${res.status}): ${redactQuery(url)}`,
      );
      return { status: 'error', reason: `http_${res.status}` };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    // NDJSON, per GitHub's docs. A gzipped file is accepted too: fetch only
    // inflates when the server sends Content-Encoding, and a stored `.gz`
    // object served as-is would otherwise parse as noise.
    const text = isGzip(bytes)
      ? gunzipSync(bytes).toString('utf8')
      : bytes.toString('utf8');
    return { status: 'ok', ...parseNdjson(text) };
  }

  async listSeats(org: string, token: string): Promise<CopilotSeatList> {
    if (!token) {
      return { status: 'forbidden', httpStatus: 0 };
    }
    const seats: GithubCopilotSeat[] = [];
    let url: string | undefined =
      `${this.baseUrl}/orgs/${encodeURIComponent(org)}/copilot/billing/seats?per_page=100`;
    for (let page = 0; url; page++) {
      if (page >= SEAT_PAGE_LIMIT) {
        return { status: 'ok', seats, truncated: true };
      }
      const res = await fetch(url, { headers: this.headers(token) });
      const limited = this.rateLimited(res);
      if (limited) {
        return limited;
      }
      if (!res.ok) {
        this.logger.warn(
          `Copilot seat list for "${org}" failed (${res.status})`,
        );
        return { status: failureFor(res.status), httpStatus: res.status };
      }
      const body = (await res.json()) as { seats?: unknown };
      if (Array.isArray(body.seats)) {
        seats.push(...(body.seats as GithubCopilotSeat[]));
      }
      url = nextApiLink(res.headers.get('link'));
    }
    return { status: 'ok', seats, truncated: false };
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': COPILOT_METRICS_API_VERSION,
    };
  }

  /**
   * A 403 is a rate limit only when GitHub says so (`x-ratelimit-remaining:
   * 0`); otherwise it is a refusal — missing `read:org`, an SSO-unauthorized
   * token, or the org's "Copilot usage metrics" policy switched off. Retrying
   * a refusal at the reset time would never succeed, so the two must differ.
   */
  private rateLimited(res: {
    status: number;
    headers: { get(name: string): string | null };
  }): { status: 'rate_limited'; resetAt: Date } | undefined {
    const exhausted = res.headers.get('x-ratelimit-remaining') === '0';
    if (res.status === 429 || (res.status === 403 && exhausted)) {
      const seconds = Number(res.headers.get('x-ratelimit-reset') ?? NaN);
      const resetAt = Number.isNaN(seconds)
        ? new Date(Date.now() + 60_000)
        : new Date(seconds * 1000);
      return { status: 'rate_limited', resetAt };
    }
    return undefined;
  }
}

function failureFor(status: number): CopilotFailure {
  if (status === 403 || status === 401) {
    return 'forbidden';
  }
  return status === 404 ? 'not_found' : 'error';
}

export function isAllowedReportUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' && parsed.hostname === COPILOT_REPORT_HOST
    );
  } catch {
    return false;
  }
}

/** The URL without its query — the part of a signed URL that is the secret. */
export function redactQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?<redacted>`;
}

function isGzip(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * One JSON object per line. A line that isn't one is counted and skipped
 * rather than failing the whole day: losing one malformed user record is
 * reported; losing every user's day over it would not be.
 */
export function parseNdjson(text: string): {
  records: Record<string, unknown>[];
  malformedLines: number;
} {
  const records: Record<string, unknown>[] = [];
  let malformedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      } else {
        malformedLines++;
      }
    } catch {
      malformedLines++;
    }
  }
  return { records, malformedLines };
}

/**
 * The `rel="next"` URL, followed only while it stays on api.github.com — the
 * token is attached to it, so a Link header pointing anywhere else ends the
 * walk instead of sending the token there.
 */
export function nextApiLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) {
    return undefined;
  }
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) {
      try {
        const url = new URL(match[1]);
        return url.protocol === 'https:' && url.hostname === 'api.github.com'
          ? url.toString()
          : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
