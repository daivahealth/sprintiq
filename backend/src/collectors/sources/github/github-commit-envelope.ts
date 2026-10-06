import { CodeCommitPayload } from '../../../common/events/contracts';
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
