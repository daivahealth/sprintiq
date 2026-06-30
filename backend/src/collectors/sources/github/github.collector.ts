import { Injectable } from '@nestjs/common';
import { Connection } from '@prisma/client';
import { CodePullRequestPayload } from '../../../common/events/contracts';
import { EventTypes } from '../../../common/events/event-types';
import { newId } from '../../../common/id';
import { CanonicalEnvelope } from '../../ingestion/canonical-envelope';
import { BaseSourceCollector } from '../../framework/source-collector';
import { GithubClient, GithubPull } from './github.client';

/**
 * Native GitHub collector (BC-1): normalizes `pull_request` webhooks and polls
 * the PR list, both into the canonical `code.pull_request.*` envelope. Jira-key
 * extraction happens downstream in correlation.
 */
@Injectable()
export class GithubCollector extends BaseSourceCollector {
  readonly source = 'github';

  constructor(private readonly client: GithubClient) {
    super();
  }

  async normalizeWebhook(
    connection: Connection,
    rawBody: Buffer,
    headers: Record<string, unknown>,
  ): Promise<CanonicalEnvelope[]> {
    if (headers['x-github-event'] !== 'pull_request') {
      return []; // slice handles PR events; other event types added later
    }
    const body = JSON.parse(rawBody.toString('utf8'));
    const pr = body.pull_request;
    const repoFullName: string | undefined = body.repository?.full_name;
    if (!pr || !repoFullName) {
      return [];
    }
    const number = String(body.number ?? pr.number);
    const { eventType, state } = mapAction(body.action, Boolean(pr.merged));

    const payload: CodePullRequestPayload = {
      repoFullName,
      externalNumber: number,
      title: pr.title ?? '',
      branch: pr.head?.ref ?? '',
      baseBranch: pr.base?.ref,
      state,
      authorLogin: pr.user?.login,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      openedAt: pr.created_at,
      mergedAt: pr.merged_at ?? undefined,
    };

    return [
      this.envelope(
        connection,
        'webhook',
        eventType,
        number,
        repoFullName,
        pr.updated_at ?? pr.created_at,
        pr.user?.login,
        payload,
      ),
    ];
  }

  async poll(connection: Connection): Promise<CanonicalEnvelope[]> {
    const repoFullName = (connection.config as Record<string, unknown>)
      ?.repoFullName as string | undefined;
    if (!repoFullName) {
      return [];
    }
    const token = connection.secretRef
      ? (process.env[connection.secretRef] ?? '')
      : '';
    const pulls = await this.client.listRecentPullRequests(repoFullName, token);
    return pulls.map((pr) => this.fromPolledPull(connection, repoFullName, pr));
  }

  private fromPolledPull(
    connection: Connection,
    repoFullName: string,
    pr: GithubPull,
  ): CanonicalEnvelope {
    const merged = Boolean(pr.merged_at);
    const eventType = merged
      ? EventTypes.CODE_PR_MERGED
      : pr.state === 'open'
        ? EventTypes.CODE_PR_OPENED
        : EventTypes.CODE_PR_CLOSED;
    const payload: CodePullRequestPayload = {
      repoFullName,
      externalNumber: String(pr.number),
      title: pr.title,
      branch: pr.head?.ref ?? '',
      baseBranch: pr.base?.ref,
      state: merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
      authorLogin: pr.user?.login,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      openedAt: pr.created_at,
      mergedAt: pr.merged_at ?? undefined,
    };
    return this.envelope(
      connection,
      'poll',
      eventType,
      String(pr.number),
      repoFullName,
      pr.merged_at ?? pr.created_at,
      pr.user?.login,
      payload,
    );
  }

  private envelope(
    connection: Connection,
    mode: 'webhook' | 'poll',
    eventType: string,
    number: string,
    repoFullName: string,
    occurredAt: string,
    actorLogin: string | undefined,
    payload: CodePullRequestPayload,
  ): CanonicalEnvelope {
    return {
      schemaVersion: '1.0',
      eventId: newId(),
      // Deterministic so webhook + poll converge on one raw event.
      idempotencyKey: `github:${repoFullName}:pr:${number}:${eventType}`,
      sourceSystem: 'github',
      connectionId: connection.id,
      collectionMode: mode,
      eventType,
      occurredAt: occurredAt ?? this.nowIso(),
      collectedAt: this.nowIso(),
      externalRefs: {
        repo: repoFullName,
        pr_number: number,
        org: repoFullName.split('/')[0] ?? '',
      },
      actor: { sourceLogin: actorLogin },
      data: payload as unknown as Record<string, unknown>,
    };
  }
}

function mapAction(
  action: string | undefined,
  merged: boolean,
): { eventType: string; state: CodePullRequestPayload['state'] } {
  if (action === 'opened' || action === 'reopened') {
    return { eventType: EventTypes.CODE_PR_OPENED, state: 'open' };
  }
  if (action === 'closed') {
    return merged
      ? { eventType: EventTypes.CODE_PR_MERGED, state: 'merged' }
      : { eventType: EventTypes.CODE_PR_CLOSED, state: 'closed' };
  }
  return { eventType: EventTypes.CODE_PR_UPDATED, state: 'open' };
}
