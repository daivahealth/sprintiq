/**
 * Canonical internal domain event. Every event is tenant-scoped and carries the
 * lineage back to the raw source event(s) that produced it. This is the async
 * backbone (collectors → correlation → metrics → rules → agents → notifications)
 * that survives a future monolith→services split unchanged (ADR-0001).
 */
export interface DomainEvent<T = unknown> {
  /** Stable event type, e.g. 'code.pull_request.merged' (see docs/api/README.md §6). */
  type: string;
  tenantId: string;
  /** Originating connection (BC-0), when the event came from a collector. */
  connectionId?: string;
  /** Raw-event id(s) this was derived from, for lineage (BC-16). */
  sourceEventIds?: string[];
  occurredAt: Date;
  payload: T;
}

export type DomainEventHandler<T = unknown> = (
  event: DomainEvent<T>,
) => void | Promise<void>;
