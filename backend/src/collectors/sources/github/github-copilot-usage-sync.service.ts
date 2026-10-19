import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AUDIT_SINK, AuditSink } from '../../../common/audit/audit-sink';
import {
  CodeCopilotReportDayPayload,
  CodeCopilotSeatRef,
  CodeCopilotSeatsPayload,
  CodeCopilotUsagePayload,
} from '../../../common/events/contracts';
import { EventTypes } from '../../../common/events/event-types';
import { newId } from '../../../common/id';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { CanonicalEnvelope } from '../../ingestion/canonical-envelope';
import { IngestionService } from '../../ingestion/ingestion.service';
import {
  GithubCopilotMetricsClient,
  GithubCopilotSeat,
} from './github-copilot-metrics.client';
import { readGithubCopilotConfig } from './github-copilot.config';

/** The tenant-configuration field that names the Copilot metrics token's secret ref. */
export const COPILOT_TOKEN_REF_FIELD = 'copilotMetricsTokenRef';

/** GitHub's usage-metrics reports start here; nothing earlier exists. */
export const COPILOT_REPORTS_FLOOR_DAY = '2025-10-10';

/**
 * Days re-fetched behind the newest ingested one. GitHub makes a day's report
 * available within ~2 full UTC days but finalizes it over ~3, so the newest
 * days can be restated; re-reading them is how a restatement reaches us.
 */
export const COPILOT_RESTATEMENT_DAYS = 3;

export type CopilotSyncStatus =
  | 'ok'
  | 'not_ready'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'no_token'
  | 'error';

export interface CopilotSyncResult {
  status: CopilotSyncStatus | 'not_configured';
  org?: string;
  daysRequested: number;
  daysIngested: number;
  recordsAccepted: number;
  recordsDuplicate: number;
  recordsSkipped: number;
  malformedLines: number;
  lastCompleteDay: string | null;
  seats: 'ok' | 'skipped' | 'truncated' | CopilotSyncStatus;
  error?: string;
}

interface CopilotSettings {
  connectionId: string;
  org: string;
  tokenRef: string;
}

/**
 * Pulls GitHub's per-user Copilot usage metrics and seat list into the
 * ingestion pipeline (BC-1, ADR-0012). Per tenant, per run:
 *
 * 1. Walk UTC days from the cursor (re-reading the last
 *    `COPILOT_RESTATEMENT_DAYS`) up to yesterday, stopping at the first day
 *    GitHub says isn't ready (204) or any failure — so the cursor only ever
 *    covers days whose report was read whole.
 * 2. Each user record → one `code.copilot.usage.reported` event; each day →
 *    one `code.copilot.report_day.collected` marker; the seat list → one
 *    `code.copilot.seats.observed` snapshot.
 *
 * Idempotency keys carry a hash of the content, so re-reading an unchanged
 * report is a no-op while a restated record lands as a new raw event the
 * projector applies last-wins: at-least-once fetching, one converged result.
 *
 * Uses its own secret ref and never falls back to the collector token: this
 * one needs org-level `read:org` (or "View organization Copilot metrics"), and
 * borrowing a token silently would hide which credential holds that access.
 */
@Injectable()
export class GithubCopilotUsageSyncService {
  private readonly logger = new Logger(GithubCopilotUsageSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly client: GithubCopilotMetricsClient,
    private readonly ingestion: IngestionService,
    @Optional() @Inject(AUDIT_SINK) private readonly audit?: AuditSink,
  ) {}

  /** Tenants with an active GitHub configuration that names a Copilot token ref. */
  async listEnabledTenants(): Promise<string[]> {
    const rows = await this.prisma.tenantConfiguration.findMany({
      where: { namespace: 'github', key: 'default', status: 'active' },
      select: { tenantId: true, secretRefs: true },
    });
    return rows
      .filter(
        (r) =>
          typeof (r.secretRefs as Record<string, unknown> | null)?.[
            COPILOT_TOKEN_REF_FIELD
          ] === 'string',
      )
      .map((r) => r.tenantId);
  }

  /** Read-only, tenant-scoped: the cursor and last outcome per org. */
  async status(tenantId: string): Promise<{
    syncEnabled: boolean;
    orgs: {
      org: string;
      lastCompleteDay: string | null;
      lastRunAt: string | null;
      lastStatus: string | null;
      lastError: string | null;
    }[];
  }> {
    const rows = await this.prisma.githubCopilotSync.findMany({
      where: { tenantId },
      orderBy: { org: 'asc' },
    });
    return {
      syncEnabled: readGithubCopilotConfig().syncEnabled,
      orgs: rows.map((r) => ({
        org: r.org,
        lastCompleteDay: r.lastCompleteDay
          ? utcDayKey(r.lastCompleteDay)
          : null,
        lastRunAt: r.lastRunAt?.toISOString() ?? null,
        lastStatus: r.lastStatus,
        lastError: r.lastError,
      })),
    };
  }

  async syncTenant(
    tenantId: string,
    now: Date = new Date(),
  ): Promise<CopilotSyncResult> {
    const result: CopilotSyncResult = {
      status: 'ok',
      daysRequested: 0,
      daysIngested: 0,
      recordsAccepted: 0,
      recordsDuplicate: 0,
      recordsSkipped: 0,
      malformedLines: 0,
      lastCompleteDay: null,
      seats: 'skipped',
    };

    const settings = await this.loadSettings(tenantId);
    if (!settings) {
      return { ...result, status: 'not_configured' };
    }
    result.org = settings.org;

    const cursor = await this.prisma.githubCopilotSync.findUnique({
      where: { tenantId_org: { tenantId, org: settings.org } },
    });
    const previousComplete = cursor?.lastCompleteDay
      ? utcDayKey(cursor.lastCompleteDay)
      : null;
    result.lastCompleteDay = previousComplete;

    const token = await this.secrets.resolve(tenantId, settings.tokenRef);
    if (!token) {
      result.status = 'no_token';
      result.error = `No value stored (or set via env var) for secret ref "${settings.tokenRef}".`;
      await this.finish(tenantId, settings, result, now);
      return result;
    }

    const { backfillDays } = readGithubCopilotConfig();
    const days = copilotDaysToFetch(previousComplete, now, backfillDays);
    result.daysRequested = days.length;

    for (const day of days) {
      const outcome = await this.ingestDay(tenantId, settings, day, token, now);
      result.recordsAccepted += outcome.accepted;
      result.recordsDuplicate += outcome.duplicate;
      result.recordsSkipped += outcome.skipped;
      result.malformedLines += outcome.malformed;
      if (outcome.status !== 'ok') {
        // `not_ready` is the normal end of the walk — a later day can't be
        // ready when this one isn't — not an error, but still where it stops.
        result.status = outcome.status;
        result.error = outcome.error;
        break;
      }
      result.daysIngested += 1;
      if (!result.lastCompleteDay || day > result.lastCompleteDay) {
        result.lastCompleteDay = day;
      }
    }
    if (result.status === 'not_ready') {
      result.status = 'ok';
    }

    // Seats are read even when the usage walk stopped early: "who has a seat"
    // doesn't depend on any report day, and a refused usage call often means
    // a policy setting that the seats endpoint isn't subject to.
    result.seats = await this.ingestSeats(tenantId, settings, token, now);

    await this.finish(tenantId, settings, result, now);
    return result;
  }

  private async ingestDay(
    tenantId: string,
    settings: CopilotSettings,
    day: string,
    token: string,
    now: Date,
  ): Promise<{
    status: CopilotSyncStatus;
    error?: string;
    accepted: number;
    duplicate: number;
    skipped: number;
    malformed: number;
  }> {
    const counts = { accepted: 0, duplicate: 0, skipped: 0, malformed: 0 };
    const report = await this.client.getUsersDayReport(
      settings.org,
      day,
      token,
    );
    if (report.status === 'not_ready') {
      return { status: 'not_ready', ...counts };
    }
    if (report.status === 'rate_limited') {
      return {
        status: 'rate_limited',
        error: `Rate-limited until ${report.resetAt.toISOString()} while reading ${day}.`,
        ...counts,
      };
    }
    if (report.status !== 'ok') {
      return {
        status: report.status,
        error: refusalHint(report.status, report.httpStatus, day),
        ...counts,
      };
    }

    // Download every file before ingesting any of them: a day is only marked
    // collected when the whole report was read, so a half-read day is retried
    // whole rather than half-remembered.
    const records: Record<string, unknown>[] = [];
    for (const link of report.links) {
      const file = await this.client.downloadReport(link);
      if (file.status !== 'ok') {
        return {
          status: 'error',
          error: `Report download for ${day} failed (${file.reason}).`,
          ...counts,
        };
      }
      records.push(...file.records);
      counts.malformed += file.malformedLines;
    }

    const recordKeys: string[] = [];
    const userIds: number[] = [];
    for (const record of records) {
      const envelope = usageEnvelope(
        settings.connectionId,
        settings.org,
        day,
        record,
        now,
      );
      if (!envelope) {
        counts.skipped += 1;
        continue;
      }
      userIds.push(Number(envelope.externalRefs.githubUserId));
      recordKeys.push(envelope.idempotencyKey);
      const ingested = await this.ingestion.ingest(tenantId, envelope);
      if (ingested.status === 'accepted') {
        counts.accepted += 1;
      } else {
        counts.duplicate += 1;
      }
    }

    await this.ingestion.ingest(
      tenantId,
      reportDayEnvelope(
        settings.connectionId,
        settings.org,
        day,
        userIds,
        recordKeys,
        now,
      ),
    );
    return { status: 'ok', ...counts };
  }

  private async ingestSeats(
    tenantId: string,
    settings: CopilotSettings,
    token: string,
    now: Date,
  ): Promise<CopilotSyncResult['seats']> {
    const list = await this.client.listSeats(settings.org, token);
    if (list.status !== 'ok') {
      this.logger.warn(
        `Copilot seat list for "${settings.org}" (tenant ${tenantId}): ${list.status}`,
      );
      return list.status;
    }
    if (list.truncated) {
      // The projection replaces the seat list whole. A truncated list would
      // read as everyone past the cut-off having lost their seat.
      this.logger.warn(
        `Copilot seat list for "${settings.org}" exceeded the page limit — not ingested.`,
      );
      return 'truncated';
    }
    await this.ingestion.ingest(
      tenantId,
      seatsEnvelope(settings.connectionId, settings.org, list.seats, now),
    );
    return 'ok';
  }

  private async loadSettings(
    tenantId: string,
  ): Promise<CopilotSettings | null> {
    const row = await this.prisma.tenantConfiguration.findUnique({
      where: {
        tenantId_namespace_key: {
          tenantId,
          namespace: 'github',
          key: 'default',
        },
      },
      select: { id: true, status: true, values: true, secretRefs: true },
    });
    if (!row || row.status !== 'active') {
      return null;
    }
    const values = (row.values ?? {}) as Record<string, unknown>;
    const refs = (row.secretRefs ?? {}) as Record<string, unknown>;
    const org = values.organization;
    const tokenRef = refs[COPILOT_TOKEN_REF_FIELD];
    if (typeof org !== 'string' || !org || typeof tokenRef !== 'string') {
      return null;
    }
    // The configuration row stands in for a connection: Copilot metrics are
    // org-level, so no repo connection owns them, and this id is what ties
    // each raw event back to the configuration that collected it.
    return { connectionId: row.id, org, tokenRef };
  }

  private async finish(
    tenantId: string,
    settings: CopilotSettings,
    result: CopilotSyncResult,
    now: Date,
  ): Promise<void> {
    const fields = {
      lastCompleteDay: result.lastCompleteDay
        ? new Date(`${result.lastCompleteDay}T00:00:00.000Z`)
        : null,
      lastRunAt: now,
      lastStatus: result.status,
      lastError: result.error ?? null,
    };
    await this.prisma.githubCopilotSync.upsert({
      where: { tenantId_org: { tenantId, org: settings.org } },
      create: { id: newId(), tenantId, org: settings.org, ...fields },
      update: fields,
    });
    await this.audit?.record({
      tenantId,
      actorType: 'system',
      action: 'collector.copilot_usage_sync',
      targetType: 'github_org',
      targetId: settings.org,
      metadata: { ...result },
    });
    this.logger.log(
      `Copilot usage sync for "${settings.org}" (tenant ${tenantId}): ${result.status}, ${result.daysIngested}/${result.daysRequested} day(s), ${result.recordsAccepted} new record(s), through ${result.lastCompleteDay ?? 'nothing yet'}.`,
    );
  }
}

function refusalHint(status: string, httpStatus: number, day: string): string {
  if (status === 'forbidden') {
    return `GitHub refused the usage report for ${day} (${httpStatus}). Check the token has read:org (or "View organization Copilot metrics"), is SSO-authorized for the org, and that the "Copilot usage metrics" policy is enabled.`;
  }
  if (status === 'not_found') {
    return `GitHub has no usage report for ${day} (404) — the org name, or Copilot not being enabled for it.`;
  }
  return `Usage report for ${day} failed (${httpStatus}).`;
}

/** `YYYY-MM-DD` of a Date in UTC — GitHub's report days are UTC days. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return utcDayKey(d);
}

/**
 * The UTC days one run asks for, oldest first.
 *
 * Up to yesterday: a day's report usually lands ~2 days after it closes, so
 * the newest asks typically answer 204, and the walk stops there at the cost
 * of one request. The start is the cursor less the restatement window, or —
 * on the first run — `backfillDays` back. Never earlier than GitHub's first
 * report day, nor than the one year of history it keeps.
 */
export function copilotDaysToFetch(
  lastCompleteDay: string | null,
  now: Date,
  backfillDays: number,
): string[] {
  const today = utcDayKey(now);
  const latest = addDays(today, -1);
  const oldestKept = addDays(today, -365);
  let start = lastCompleteDay
    ? addDays(lastCompleteDay, -(COPILOT_RESTATEMENT_DAYS - 1))
    : addDays(latest, -(backfillDays - 1));
  for (const floor of [COPILOT_REPORTS_FLOOR_DAY, oldestKept]) {
    if (start < floor) {
      start = floor;
    }
  }
  const days: string[] = [];
  for (let day = start; day <= latest; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

/** Deterministic JSON — key order can't change a content hash. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(value: unknown): string {
  return createHash('sha256')
    .update(stableStringify(value))
    .digest('hex')
    .slice(0, 12);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function int(value: unknown): number {
  return Math.trunc(num(value));
}

/**
 * One report record → its envelope, or `null` when the record names no user
 * (nothing to attribute it to; counted as skipped by the caller).
 */
export function usageEnvelope(
  connectionId: string,
  org: string,
  day: string,
  record: Record<string, unknown>,
  now: Date,
): CanonicalEnvelope | null {
  const userId = record.user_id;
  const login = record.user_login;
  if (
    typeof userId !== 'number' ||
    !Number.isFinite(userId) ||
    typeof login !== 'string' ||
    !login
  ) {
    return null;
  }
  const data: CodeCopilotUsagePayload = {
    org,
    day,
    githubUserId: userId,
    login,
    interactions: int(record.user_initiated_interaction_count),
    generations: int(record.code_generation_activity_count),
    acceptances: int(record.code_acceptance_activity_count),
    locSuggestedAdd: int(record.loc_suggested_to_add_sum),
    locSuggestedDelete: int(record.loc_suggested_to_delete_sum),
    locAdded: int(record.loc_added_sum),
    locDeleted: int(record.loc_deleted_sum),
    usedAgent: record.used_agent === true,
    usedChat: record.used_chat === true,
    usedCli: record.used_cli === true,
    // GitHub renamed the coding agent to the cloud agent and reports both.
    usedCodingAgent:
      record.used_copilot_coding_agent === true ||
      record.used_copilot_cloud_agent === true,
    aiCreditsUsed:
      typeof record.ai_credits_used === 'number'
        ? record.ai_credits_used
        : null,
    collectedAt: now.toISOString(),
    record,
  };
  return {
    schemaVersion: '1.0',
    eventId: newId(),
    idempotencyKey: `github:copilot:${org}:${day}:user:${userId}:${contentHash(record)}`,
    sourceSystem: 'github',
    connectionId,
    collectionMode: 'poll',
    eventType: EventTypes.CODE_COPILOT_USAGE_REPORTED,
    occurredAt: `${day}T00:00:00.000Z`,
    collectedAt: now.toISOString(),
    externalRefs: { org, day, githubUserId: String(userId) },
    actor: { sourceLogin: login },
    data: data as unknown as Record<string, unknown>,
  };
}

export function reportDayEnvelope(
  connectionId: string,
  org: string,
  day: string,
  githubUserIds: number[],
  recordKeys: string[],
  now: Date,
): CanonicalEnvelope {
  const data: CodeCopilotReportDayPayload = {
    org,
    day,
    userCount: githubUserIds.length,
    githubUserIds: [...githubUserIds].sort((a, b) => a - b),
    collectedAt: now.toISOString(),
  };
  return {
    schemaVersion: '1.0',
    eventId: newId(),
    // Keyed on the report's content, so an unchanged re-read is a duplicate
    // and a restated report records itself again.
    idempotencyKey: `github:copilot:${org}:${day}:report:${contentHash([...recordKeys].sort())}`,
    sourceSystem: 'github',
    connectionId,
    collectionMode: 'poll',
    eventType: EventTypes.CODE_COPILOT_REPORT_DAY_COLLECTED,
    occurredAt: `${day}T00:00:00.000Z`,
    collectedAt: now.toISOString(),
    externalRefs: { org, day },
    data: data as unknown as Record<string, unknown>,
  };
}

export function toSeatRef(seat: GithubCopilotSeat): CodeCopilotSeatRef | null {
  const login = seat.assignee?.login;
  const id = seat.assignee?.id;
  // Seats assigned to a team rather than a user carry no login to attribute.
  if (typeof login !== 'string' || !login || typeof id !== 'number') {
    return null;
  }
  return {
    githubUserId: id,
    login,
    ...(seat.created_at ? { assignedAt: seat.created_at } : {}),
    ...(seat.last_activity_at ? { lastActivityAt: seat.last_activity_at } : {}),
    ...(seat.last_activity_editor
      ? { lastActivityEditor: seat.last_activity_editor }
      : {}),
    ...(seat.pending_cancellation_date
      ? { pendingCancellationDate: seat.pending_cancellation_date }
      : {}),
  };
}

export function seatsEnvelope(
  connectionId: string,
  org: string,
  seats: GithubCopilotSeat[],
  now: Date,
): CanonicalEnvelope {
  const refs = seats
    .map(toSeatRef)
    .filter((s): s is CodeCopilotSeatRef => s !== null)
    .sort((a, b) => a.githubUserId - b.githubUserId);
  const data: CodeCopilotSeatsPayload = {
    org,
    observedAt: now.toISOString(),
    seats: refs,
  };
  return {
    schemaVersion: '1.0',
    eventId: newId(),
    idempotencyKey: `github:copilot:${org}:seats:${contentHash(refs)}`,
    sourceSystem: 'github',
    connectionId,
    collectionMode: 'poll',
    eventType: EventTypes.CODE_COPILOT_SEATS_OBSERVED,
    occurredAt: now.toISOString(),
    collectedAt: now.toISOString(),
    externalRefs: { org },
    data: data as unknown as Record<string, unknown>,
  };
}
