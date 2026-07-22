import { Injectable } from '@nestjs/common';
import { Connection } from '@prisma/client';
import {
  PlanningSprintRef,
  PlanningStoryPayload,
} from '../../../common/events/contracts';
import { EventTypes } from '../../../common/events/event-types';
import { newId } from '../../../common/id';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { ConnectionsService } from '../../../modules/connections/connections.service';
import {
  CanonicalEnvelope,
  CollectionMode,
  EnvelopeActor,
} from '../../ingestion/canonical-envelope';
import { BaseSourceCollector } from '../../framework/source-collector';
import { JiraClient, JiraSearchIssue } from './jira.client';

const TYPE_MAP: Record<string, string> = {
  Story: 'story',
  Bug: 'bug',
  Task: 'task',
  Spike: 'spike',
  Epic: 'epic',
  'Sub-task': 'subtask',
  Subtask: 'subtask',
};

/** Bounds how much work one scheduler tick does — large projects catch up over several ticks. */
const PAGE_BUDGET_PER_TICK = 3;
const PAGE_SIZE = 50;
/** Default historical lookback when a connection doesn't set `config.backfillSince`. */
const DEFAULT_BACKFILL_DAYS = 90;

interface JiraSyncCursors {
  /** `startAt` to resume from within the current cursor's JQL pass. */
  resumeStartAt?: number;
  /** Watermark: `updated >=` floor for the JQL search; advances once a full pass completes. */
  updatedCursor?: string;
}

/**
 * Native Jira collector (BC-1): normalizes issue webhooks AND runs the
 * scheduled sync (backfill on first runs, then incremental reconciliation via
 * JQL `updated >=`) into the canonical `planning.issue.*` envelope, including
 * the detailing dimensions — epic/parent hierarchy, sprint, fixVersions
 * (releases), assignee, priority, resolution.
 */
@Injectable()
export class JiraCollector extends BaseSourceCollector {
  readonly source = 'jira';

  constructor(
    private readonly client: JiraClient,
    private readonly connections: ConnectionsService,
    private readonly secrets: SecretsService,
  ) {
    super();
  }

  async normalizeWebhook(
    connection: Connection,
    rawBody: Buffer,
    _headers: Record<string, unknown>,
  ): Promise<CanonicalEnvelope[]> {
    const body = JSON.parse(rawBody.toString('utf8'));
    const webhookEvent: string = body.webhookEvent ?? '';
    const issue = body.issue;
    if (!issue?.key) {
      return [];
    }
    const eventType =
      webhookEvent === 'jira:issue_created'
        ? EventTypes.PLANNING_STORY_CREATED
        : EventTypes.PLANNING_STORY_UPDATED;

    const payload = this.mapIssueToPayload(issue.key, issue.fields ?? {});
    const occurredAt: string = issue.fields?.updated ?? this.nowIso();

    return [
      this.envelope(
        connection,
        'webhook',
        eventType,
        issue.key,
        occurredAt,
        payload,
        {
          sourceLogin: body.user?.name,
          displayName: body.user?.displayName,
        },
      ),
    ];
  }

  /**
   * Scheduled sync: JQL `updated >= <cursor>` ORDER BY updated ASC, paginated
   * by `startAt`. The same query shape covers both the initial backfill
   * (cursor = the bounded lookback floor) and incremental reconciliation
   * (cursor = the last-synced watermark) — no separate code paths needed,
   * since Jira's search API (unlike GitHub's PR list) filters by date natively.
   */
  async poll(connection: Connection): Promise<CanonicalEnvelope[]> {
    const config = (connection.config ?? {}) as {
      siteUrl?: string;
      email?: string;
      projectKey?: string;
      backfillSince?: string;
    };
    if (!config.siteUrl || !config.email) {
      return [];
    }

    const rateLimitState = (connection.rateLimitState ?? {}) as {
      resetAt?: string;
    };
    if (
      rateLimitState.resetAt &&
      new Date(rateLimitState.resetAt).getTime() > Date.now()
    ) {
      return [];
    }

    const apiToken = await this.secrets.resolve(
      connection.tenantId,
      connection.secretRef,
    );
    if (!apiToken) {
      return [];
    }

    const cursors: JiraSyncCursors = {
      ...((connection.syncCursors as JiraSyncCursors | null) ?? {}),
    };
    const floor = cursors.updatedCursor
      ? new Date(cursors.updatedCursor)
      : resolveBackfillFloor(config.backfillSince);
    const mode: CollectionMode = cursors.updatedCursor ? 'poll' : 'backfill';

    const jqlParts = [`updated >= "${toJqlDate(floor)}"`];
    if (config.projectKey) {
      jqlParts.unshift(`project = "${config.projectKey}"`);
    }
    const jql = `${jqlParts.join(' AND ')} ORDER BY updated ASC`;

    const envelopes: CanonicalEnvelope[] = [];
    let startAt = cursors.resumeStartAt ?? 0;
    let lastSeenUpdatedAt: string | undefined;
    let rateLimitedUntil: Date | undefined;
    let passComplete = false;

    for (let fetched = 0; fetched < PAGE_BUDGET_PER_TICK; fetched++) {
      const page = await this.client.searchIssues(
        config.siteUrl,
        config.email,
        apiToken,
        { jql, startAt, maxResults: PAGE_SIZE },
      );
      if (page.rateLimitedUntil) {
        rateLimitedUntil = page.rateLimitedUntil;
        break;
      }
      for (const issue of page.issues) {
        envelopes.push(this.fromPolledIssue(connection, issue, mode));
        const updated = issue.fields?.updated;
        if (typeof updated === 'string') {
          lastSeenUpdatedAt = updated;
        }
      }
      startAt += page.issues.length;
      if (page.issues.length === 0 || startAt >= page.total) {
        passComplete = true;
        break;
      }
    }

    if (rateLimitedUntil) {
      cursors.resumeStartAt = startAt;
    } else if (passComplete) {
      cursors.resumeStartAt = undefined;
      // A `>=` floor re-includes the boundary issue next pass — harmless,
      // the idempotency key on (issueKey, eventType, updated) dedupes it.
      cursors.updatedCursor = lastSeenUpdatedAt ?? new Date().toISOString();
    } else {
      cursors.resumeStartAt = startAt; // budget exhausted — resume next tick
    }

    await this.connections.setSyncCursors(
      connection.id,
      cursors as unknown as Record<string, unknown>,
    );
    await this.connections.setRateLimitState(
      connection.id,
      rateLimitedUntil ? { resetAt: rateLimitedUntil.toISOString() } : {},
    );

    return envelopes;
  }

  private fromPolledIssue(
    connection: Connection,
    issue: JiraSearchIssue,
    mode: CollectionMode,
  ): CanonicalEnvelope {
    const payload = this.mapIssueToPayload(issue.key, issue.fields ?? {});
    const occurredAt =
      typeof issue.fields?.updated === 'string'
        ? issue.fields.updated
        : this.nowIso();
    // Poll never distinguishes "created" from "updated" from a search result alone.
    return this.envelope(
      connection,
      mode,
      EventTypes.PLANNING_STORY_UPDATED,
      issue.key,
      occurredAt,
      payload,
    );
  }

  private envelope(
    connection: Connection,
    mode: CollectionMode,
    eventType: string,
    issueKey: string,
    occurredAt: string,
    payload: PlanningStoryPayload,
    actor?: EnvelopeActor,
  ): CanonicalEnvelope {
    return {
      schemaVersion: '1.0',
      eventId: newId(),
      // Deterministic so webhook + poll converge on one persisted record.
      idempotencyKey: `jira:${issueKey}:${eventType}:${occurredAt}`,
      sourceSystem: 'jira',
      connectionId: connection.id,
      collectionMode: mode,
      eventType,
      occurredAt,
      collectedAt: this.nowIso(),
      externalRefs: { issue_key: issueKey, project: payload.projectKey },
      actor,
      data: payload as unknown as Record<string, unknown>,
    };
  }

  private mapIssueToPayload(
    issueKey: string,
    fields: Record<string, unknown>,
  ): PlanningStoryPayload {
    const project = fields.project as { key?: string } | undefined;
    const issuetype = fields.issuetype as
      { name?: string; subtask?: boolean } | undefined;
    const projectKey: string = project?.key ?? 'UNKNOWN';
    const issueTypeName: string = issuetype?.name ?? 'Story';
    const isSubtask = Boolean(issuetype?.subtask);
    const type = isSubtask ? 'subtask' : (TYPE_MAP[issueTypeName] ?? 'story');

    // Parent resolution: Jira's `parent` is the epic for stories (team-managed)
    // or the parent story for subtasks; classic epics arrive via `epic` field.
    const parent = fields.parent as
      { key?: string; fields?: { issuetype?: { name?: string } } } | undefined;
    const parentIsEpic =
      parent?.fields?.issuetype?.name === 'Epic' ||
      TYPE_MAP[parent?.fields?.issuetype?.name ?? ''] === 'epic';
    const epic = fields.epic as { key?: string } | undefined;
    const epicKey: string | undefined =
      epic?.key ??
      (typeof fields.epicKey === 'string' ? fields.epicKey : undefined) ??
      (parentIsEpic ? parent?.key : undefined);
    const parentKey: string | undefined =
      isSubtask && parent?.key ? parent.key : undefined;

    const status = fields.status as { name?: string } | undefined;
    const assignee = fields.assignee as
      { name?: string; accountId?: string; displayName?: string } | undefined;
    const priority = fields.priority as { name?: string } | undefined;
    const fixVersions = fields.fixVersions;

    return {
      externalKey: issueKey,
      projectKey,
      type,
      status: status?.name ?? 'unknown',
      storyPoints:
        typeof fields.storyPoints === 'number' ? fields.storyPoints : undefined,
      title: typeof fields.summary === 'string' ? fields.summary : '',
      epicKey,
      parentKey,
      sprint: parseSprint(fields.sprint),
      releases: Array.isArray(fixVersions)
        ? fixVersions
            .map((v: { name?: string }) => v?.name)
            .filter((n: unknown): n is string => typeof n === 'string')
        : undefined,
      assigneeLogin: assignee?.name ?? assignee?.accountId ?? undefined,
      assigneeName: assignee?.displayName ?? undefined,
      priority: priority?.name ?? undefined,
      resolvedAt:
        typeof fields.resolutiondate === 'string'
          ? fields.resolutiondate
          : undefined,
    };
  }
}

function resolveBackfillFloor(backfillSince: string | undefined): Date {
  if (backfillSince) {
    const parsed = new Date(backfillSince);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date(Date.now() - DEFAULT_BACKFILL_DAYS * 24 * 60 * 60 * 1000);
}

/** JQL date-time literal format: `yyyy/MM/dd HH:mm`, evaluated in the Jira instance's timezone. */
function toJqlDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Accepts the normalized `fields.sprint` object (id/name/state/dates). */
function parseSprint(raw: unknown): PlanningSprintRef | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const s = raw as Record<string, unknown>;
  if (s.id === undefined || typeof s.name !== 'string') {
    return undefined;
  }
  return {
    externalId: String(s.id),
    name: s.name,
    state: typeof s.state === 'string' ? s.state : undefined,
    startAt: typeof s.startDate === 'string' ? s.startDate : undefined,
    endAt: typeof s.endDate === 'string' ? s.endDate : undefined,
    goal: typeof s.goal === 'string' ? s.goal : undefined,
  };
}
