import { createHash } from 'node:crypto';
import {
  PlanningWorklogRef,
  PlanningWorklogsPayload,
} from '../../../common/events/contracts';
import { EventTypes } from '../../../common/events/event-types';
import { newId } from '../../../common/id';
import {
  CanonicalEnvelope,
  CollectionMode,
} from '../../ingestion/canonical-envelope';
import { JiraClient, JiraWorklog, JiraWorklogField } from './jira.client';

/**
 * Jira worklog collection (ADR-0014, Sprint Health Efforts), shared by the
 * poller (`JiraCollector`) and the backfill (`JiraWorklogReconcilerService`).
 *
 * Shared on purpose: the two paths must build byte-identical envelopes for the
 * same worklog set, because that is what makes their idempotency keys converge
 * — a set the poller already ingested is a duplicate when the reconciler reads
 * it again, and vice versa.
 */

/** The worklog set for one issue, ready to become a payload. */
export interface CollectedWorklogs {
  worklogs: PlanningWorklogRef[];
  /** Every worklog Jira reported for the issue is present. */
  complete: boolean;
  total: number;
}

/**
 * Jira worklogs → payload refs, dropping any entry missing what the projector
 * needs (an id to key on, a start to bucket by, a duration to sum), and sorted
 * by id so the content hash is order-independent.
 */
export function toWorklogRefs(worklogs: JiraWorklog[]): PlanningWorklogRef[] {
  const refs: PlanningWorklogRef[] = [];
  for (const w of worklogs) {
    if (
      !w?.id ||
      typeof w.started !== 'string' ||
      typeof w.timeSpentSeconds !== 'number' ||
      !Number.isFinite(w.timeSpentSeconds)
    ) {
      continue;
    }
    refs.push({
      id: String(w.id),
      // Same reference rule as the assignee and creator: `name` on Server,
      // `accountId` on Cloud — so one person keys alike across all three.
      authorLogin: w.author?.name ?? w.author?.accountId ?? undefined,
      authorName: w.author?.displayName ?? undefined,
      authorEmail: w.author?.emailAddress ?? undefined,
      started: w.started,
      timeSpentSeconds: Math.max(0, Math.round(w.timeSpentSeconds)),
      updated: typeof w.updated === 'string' ? w.updated : undefined,
    });
  }
  return refs.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The issue's complete worklog set: the embedded `worklog` field when it holds
 * everything, else a per-issue fetch to complete it.
 *
 * Returns `null` when the issue carried no `worklog` field at all — the search
 * didn't return it (an older field list, or a site that hides time tracking),
 * so there is no evidence either way and nothing is emitted. That is different
 * from an empty set, which IS evidence: "this issue has no worklogs".
 *
 * A failed completion fetch keeps the embedded entries and reports
 * `complete: false`, which the projector applies upsert-only.
 */
export async function collectIssueWorklogs(
  client: JiraClient,
  siteUrl: string,
  email: string,
  apiToken: string,
  issueKey: string,
  field: unknown,
): Promise<CollectedWorklogs | null> {
  if (!field || typeof field !== 'object') {
    return null;
  }
  const embedded = (field as JiraWorklogField).worklogs ?? [];
  const total = (field as JiraWorklogField).total ?? embedded.length;
  if (total <= embedded.length) {
    return { worklogs: toWorklogRefs(embedded), complete: true, total };
  }

  let full: JiraWorklog[] | null = null;
  try {
    full = await client.getIssueWorklogs(siteUrl, email, apiToken, issueKey);
  } catch {
    // A network-level failure rejects rather than resolving null. Same
    // treatment: keep what the search returned, flagged incomplete.
    full = null;
  }
  if (full) {
    return { worklogs: toWorklogRefs(full), complete: true, total };
  }
  return { worklogs: toWorklogRefs(embedded), complete: false, total };
}

/**
 * One `planning.issue.worklogs` envelope.
 *
 * Keyed on a hash of the set's content rather than the issue's `updated`
 * timestamp. The issue key is what made re-walks useless for every earlier
 * backfill (see `JiraStoryDateReconcilerService`): an unchanged issue produces
 * the identical key and is dropped. Hashing the content means an unchanged set
 * de-dupes, a changed one — an edit, a deletion, a new entry — lands, and the
 * poller and the reconciler converge on the same raw event for the same set.
 * Same approach as the version envelope's `jira:version:v1:<id>:<hash>`.
 */
export function worklogEnvelope(
  connectionId: string,
  mode: CollectionMode,
  issueKey: string,
  projectKey: string,
  set: CollectedWorklogs,
  nowIso: string,
): CanonicalEnvelope {
  const payload: PlanningWorklogsPayload = {
    externalKey: issueKey,
    projectKey,
    complete: set.complete,
    total: set.total,
    worklogs: set.worklogs,
  };
  return {
    schemaVersion: '1.0',
    eventId: newId(),
    idempotencyKey: `jira:worklogs:v1:${issueKey}:${worklogSetSignature(set)}`,
    sourceSystem: 'jira',
    connectionId,
    collectionMode: mode,
    eventType: EventTypes.PLANNING_WORKLOGS_OBSERVED,
    occurredAt: nowIso,
    collectedAt: nowIso,
    externalRefs: { issue_key: issueKey, project: projectKey },
    data: payload as unknown as Record<string, unknown>,
  };
}

/**
 * Content hash of a worklog set. `complete` is part of it, so a set first read
 * incomplete and later read in full is a new event even if the entries happen
 * to match — otherwise the complete read would be dropped as a duplicate and
 * the issue would never be reconciled for deletions.
 */
export function worklogSetSignature(set: CollectedWorklogs): string {
  const hash = createHash('sha256');
  hash.update(set.complete ? 'complete' : 'partial');
  for (const w of set.worklogs) {
    hash.update(
      [
        '',
        w.id,
        w.authorLogin ?? '',
        w.started,
        String(w.timeSpentSeconds),
        w.updated ?? '',
      ].join('|'),
    );
  }
  return hash.digest('hex').slice(0, 16);
}
