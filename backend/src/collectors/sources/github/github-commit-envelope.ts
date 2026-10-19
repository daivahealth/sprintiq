import {
  CodeCommitBranchObservedPayload,
  CodeCommitPayload,
} from '../../../common/events/contracts';
import { EventTypes } from '../../../common/events/event-types';
import { newId } from '../../../common/id';
import {
  CanonicalEnvelope,
  CollectionMode,
} from '../../ingestion/canonical-envelope';

/** The one key every commit route converges on (api/README.md §5). */
export function commitIdempotencyKey(
  repoFullName: string,
  sha: string,
): string {
  return `github:${repoFullName}:commit:${sha}`;
}

/**
 * The single builder for `code.commit.pushed` envelopes. The default-branch
 * walk, the PR harvest, the PR backfill and the audit-log route all mint
 * through here, so a commit reached by several routes converges on one raw
 * event and one `code_commit` row. Lineage-only refs (`extraRefs`) never
 * change the key.
 */
/** The key a commit's presence on one branch converges on. */
export function commitBranchIdempotencyKey(
  repoFullName: string,
  branch: string,
  sha: string,
): string {
  return `github:${repoFullName}:branch:${branch}:commit:${sha}`;
}

/**
 * The `code.commit.branch_observed` envelope: this commit is on this branch.
 * Lineage only — it never changes the commit's own row, so it is built here,
 * beside the commit builder, with its own key.
 */
export function buildCommitBranchEnvelope(args: {
  connectionId: string;
  repoFullName: string;
  branch: string;
  sha: string;
  observedAt: string;
  extraRefs?: Record<string, string>;
}): CanonicalEnvelope {
  const payload: CodeCommitBranchObservedPayload = {
    repoFullName: args.repoFullName,
    branch: args.branch,
    sha: args.sha,
    observedAt: args.observedAt,
  };
  return {
    schemaVersion: '1.0',
    eventId: newId(),
    idempotencyKey: commitBranchIdempotencyKey(
      args.repoFullName,
      args.branch,
      args.sha,
    ),
    sourceSystem: 'github',
    connectionId: args.connectionId,
    collectionMode: 'poll',
    eventType: EventTypes.CODE_COMMIT_BRANCH_OBSERVED,
    occurredAt: args.observedAt,
    collectedAt: args.observedAt,
    externalRefs: {
      repo: args.repoFullName,
      sha: args.sha,
      ref: args.branch,
      ...(args.extraRefs ?? {}),
    },
    data: payload as unknown as Record<string, unknown>,
  };
}

export function buildCommitEnvelope(args: {
  connectionId: string;
  mode: CollectionMode;
  repoFullName: string;
  payload: CodeCommitPayload;
  extraRefs?: Record<string, string>;
  collectedAt?: string;
}): CanonicalEnvelope {
  const { connectionId, mode, repoFullName, payload } = args;
  return {
    schemaVersion: '1.0',
    eventId: newId(),
    idempotencyKey: commitIdempotencyKey(repoFullName, payload.sha),
    sourceSystem: 'github',
    connectionId,
    collectionMode: mode,
    eventType: EventTypes.CODE_COMMIT_PUSHED,
    occurredAt: payload.authoredAt,
    collectedAt: args.collectedAt ?? new Date().toISOString(),
    externalRefs: {
      repo: repoFullName,
      sha: payload.sha,
      ...(args.extraRefs ?? {}),
    },
    actor: { sourceLogin: payload.authorLogin },
    data: payload as unknown as Record<string, unknown>,
  };
}
