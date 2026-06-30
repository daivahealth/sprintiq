/**
 * Canonical envelope — the single internal representation every collector
 * (webhook receiver or poller) normalizes source payloads into before they enter
 * the ingestion pipeline. Stable across sources; only `data` varies by
 * `eventType`. See docs/api/README.md §4.
 */
export type CollectionMode = 'webhook' | 'poll' | 'backfill';

export interface EnvelopeActor {
  sourceLogin?: string;
  email?: string;
  displayName?: string;
}

export interface CanonicalEnvelope<T = Record<string, unknown>> {
  schemaVersion: string;
  /** Unique per collected delivery (ULID). */
  eventId: string;
  /** Deterministic per logical source event so webhook + poll converge. */
  idempotencyKey: string;
  sourceSystem: string;
  connectionId: string;
  collectionMode: CollectionMode;
  /** e.g. 'code.pull_request.merged'. */
  eventType: string;
  occurredAt: string;
  collectedAt: string;
  /** Raw source identifiers as strings (never re-minted as UUID). */
  externalRefs: Record<string, string>;
  actor?: EnvelopeActor;
  data: T;
}
