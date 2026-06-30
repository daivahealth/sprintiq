import { Connection } from '@prisma/client';
import { CanonicalEnvelope } from '../ingestion/canonical-envelope';

/**
 * Contract every native source collector implements (BC-1). A collector owns all
 * I/O with one source system: it normalizes inbound webhooks into the canonical
 * envelope and polls the source API for backfill/reconciliation. Pagination,
 * rate-limit backoff, token refresh, and cursor management live inside the
 * collector — never in domain contexts ([ADR-0003]).
 */
export interface SourceCollector {
  readonly source: string;

  /** Normalize a verified raw webhook body into one or more canonical envelopes. */
  normalizeWebhook(
    connection: Connection,
    rawBody: Buffer,
    headers: Record<string, unknown>,
  ): Promise<CanonicalEnvelope[]>;

  /** Pull changes since the connection's cursor (backfill / reconciliation). */
  poll(connection: Connection): Promise<CanonicalEnvelope[]>;
}

/** Convenience base with shared helpers; concrete collectors extend per source. */
export abstract class BaseSourceCollector implements SourceCollector {
  abstract readonly source: string;
  abstract normalizeWebhook(
    connection: Connection,
    rawBody: Buffer,
    headers: Record<string, unknown>,
  ): Promise<CanonicalEnvelope[]>;
  abstract poll(connection: Connection): Promise<CanonicalEnvelope[]>;

  protected nowIso(): string {
    return new Date().toISOString();
  }
}
