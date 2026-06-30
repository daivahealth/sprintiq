import { Injectable } from '@nestjs/common';
import { Connection } from '@prisma/client';
import { PlanningStoryPayload } from '../../../common/events/contracts';
import { EventTypes } from '../../../common/events/event-types';
import { newId } from '../../../common/id';
import { CanonicalEnvelope } from '../../ingestion/canonical-envelope';
import { BaseSourceCollector } from '../../framework/source-collector';

const TYPE_MAP: Record<string, string> = {
  Story: 'story',
  Bug: 'bug',
  Task: 'task',
  Spike: 'spike',
};

/**
 * Native Jira collector (BC-1): normalizes issue webhooks into the canonical
 * `planning.issue.*` envelope so stories exist for correlation to link PRs to.
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
    const payload: PlanningStoryPayload = {
      externalKey: issue.key,
      projectKey,
      type: TYPE_MAP[fields.issuetype?.name] ?? 'story',
      status: fields.status?.name ?? 'unknown',
      storyPoints:
        typeof fields.storyPoints === 'number' ? fields.storyPoints : undefined,
      title: fields.summary ?? '',
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
