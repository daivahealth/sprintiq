import { Injectable } from '@nestjs/common';
import { Connection } from '@prisma/client';
import {
  PlanningSprintRef,
  PlanningStoryPayload,
} from '../../../common/events/contracts';
import { EventTypes } from '../../../common/events/event-types';
import { newId } from '../../../common/id';
import { CanonicalEnvelope } from '../../ingestion/canonical-envelope';
import { BaseSourceCollector } from '../../framework/source-collector';

const TYPE_MAP: Record<string, string> = {
  Story: 'story',
  Bug: 'bug',
  Task: 'task',
  Spike: 'spike',
  Epic: 'epic',
  'Sub-task': 'subtask',
  Subtask: 'subtask',
};

/**
 * Native Jira collector (BC-1): normalizes issue webhooks into the canonical
 * `planning.issue.*` envelope, including the detailing dimensions — epic/parent
 * hierarchy, sprint, fixVersions (releases), assignee, priority, resolution —
 * so every work-item granularity is queryable downstream (DASHBOARDS.md).
 * (Poller/backfill via Jira REST is added next; the slice covers webhooks.)
 */
@Injectable()
export class JiraCollector extends BaseSourceCollector {
  readonly source = 'jira';

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

    const fields = issue.fields ?? {};
    const projectKey: string = fields.project?.key ?? issue.key.split('-')[0];
    const issueTypeName: string = fields.issuetype?.name ?? 'Story';
    const isSubtask = Boolean(fields.issuetype?.subtask);
    const type = isSubtask ? 'subtask' : (TYPE_MAP[issueTypeName] ?? 'story');

    // Parent resolution: Jira's `parent` is the epic for stories (team-managed)
    // or the parent story for subtasks; classic epics arrive via `epic` field.
    const parent = fields.parent;
    const parentIsEpic =
      parent?.fields?.issuetype?.name === 'Epic' ||
      TYPE_MAP[parent?.fields?.issuetype?.name ?? ''] === 'epic';
    const epicKey: string | undefined =
      fields.epic?.key ??
      (typeof fields.epicKey === 'string' ? fields.epicKey : undefined) ??
      (parentIsEpic ? parent?.key : undefined);
    const parentKey: string | undefined =
      isSubtask && parent?.key ? parent.key : undefined;

    const payload: PlanningStoryPayload = {
      externalKey: issue.key,
      projectKey,
      type,
      status: fields.status?.name ?? 'unknown',
      storyPoints:
        typeof fields.storyPoints === 'number' ? fields.storyPoints : undefined,
      title: fields.summary ?? '',
      epicKey,
      parentKey,
      sprint: parseSprint(fields.sprint),
      releases: Array.isArray(fields.fixVersions)
        ? fields.fixVersions
            .map((v: { name?: string }) => v?.name)
            .filter((n: unknown): n is string => typeof n === 'string')
        : undefined,
      assigneeLogin:
        fields.assignee?.name ?? fields.assignee?.accountId ?? undefined,
      assigneeName: fields.assignee?.displayName ?? undefined,
      priority: fields.priority?.name ?? undefined,
      resolvedAt: fields.resolutiondate ?? undefined,
    };
    const occurredAt: string = fields.updated ?? this.nowIso();

    return [
      {
        schemaVersion: '1.0',
        eventId: newId(),
        idempotencyKey: `jira:${issue.key}:${eventType}:${occurredAt}`,
        sourceSystem: 'jira',
        connectionId: connection.id,
        collectionMode: 'webhook',
        eventType,
        occurredAt,
        collectedAt: this.nowIso(),
        externalRefs: { issue_key: issue.key, project: projectKey },
        actor: {
          sourceLogin: body.user?.name,
          displayName: body.user?.displayName,
        },
        data: payload as unknown as Record<string, unknown>,
      },
    ];
  }

  async poll(_connection: Connection): Promise<CanonicalEnvelope[]> {
    // TODO: Jira REST search since cursor (backfill/reconciliation).
    return [];
  }
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
