import { Connection } from '@prisma/client';
import { CanonicalEnvelope } from '../ingestion/canonical-envelope';

/**
 * Contract every native source collector implements (BC-1). A collector owns all
 * I/O with one source system: it normalizes inbound webhooks into the canonical
 * envelope and polls the source API for backfill/reconciliation. Pagination,
 * rate-limit backoff, token refresh, and cursor management live inside the
 * collector — never in domain contexts ([ADR-0003]).
 */
/**
 * Why a pass returned nothing without ever reaching the source.
 *
 * Load-bearing distinction: a pass that talked to the source and found no
 * changes, and a pass that never left the process, both return zero envelopes.
 * Treating them alike is what let a rate-limited connection stamp `lastSyncAt`
 * and report as freshly synced on every dashboard while its data stood still.
 */
export type PollSkipReason =
  'rate-limited' | 'no-credential' | 'not-configured';

/** What one `poll()` pass established, beyond the events it collected. */
export interface PollResult {
  envelopes: CanonicalEnvelope[];
  /** Set when the pass never reached the source — the connection was NOT synced. */
  skipped?: PollSkipReason;
  /**
   * Set when the pass DID reach the source and the source refused it — a
   * revoked token, a renamed or deleted repo, an SSO-blocked org, an expired
   * page token.
   *
   * Distinct from `skipped` (never left the process) and from a clean empty
   * pass (nothing changed). All three collect zero events, and conflating the
   * third with either of the first two is the bug this whole result type
   * exists to prevent: a rejected pass that reports success stamps
   * `lastSyncAt`, so the connection reads as freshly synced on every dashboard
   * and sinks to the back of the neediest-first sweep queue while its data
   * stands still. Envelopes collected before the refusal are still real and
   * are still ingested — only the "this connection is up to date" claim is
   * withheld.
   */
  failed?: boolean;
  /**
   * The **upper** bound of what this connection has collected: every change at
   * the source at or before this instant is in.
   *
   * Only the collector can compute this, because only it knows which of its
   * cursors are watermarks and which are resume points (see
   * `GithubSyncCursors` / `JiraSyncCursors`) — and note the reported watermark
   * need not be the same field as the resume cursor. Jira's is not: its
   * `updatedCursor` may only move on a completed pass (it keys the resume
   * token), but because Jira walks ascending, everything from the floor to
   * wherever it has paged to is genuinely collected and can be reported now.
   */
  collectedThroughAt?: Date;
  /**
   * The **lower** bound: the oldest point this connection has walked back to.
   *
   * The pair is what lets a board judge its OWN window rather than the whole
   * dataset — `[from, now]` is complete iff `collectedBackTo <= from`. With
   * only the upper bound, a tenant part-way through a 12-month walk could
   * report nothing but "incomplete" for days, even on a board showing the last
   * seven days over data that is entirely collected.
   *
   * The two sources reach it from opposite ends: GitHub walks newest-first so
   * this descends over days, while Jira walks oldest-first so it is the
   * backfill floor from the first pass.
   */
  collectedBackTo?: Date;
}

/** What the scheduler knows about this sweep that one connection cannot. */
export interface PollOptions {
  /**
   * How many connections of this source **share this connection's credential**
   * (same tenant) and are due in the current sweep — including this one.
   *
   * A collector whose per-tick cost is a constant multiplies that constant by
   * fleet size: at 195 repos the GitHub budget alone demanded ~19,500 requests
   * against a 5,000/hour limit, so the head of the sweep spent the entire hour
   * and the tail collected nothing. Only the scheduler can see the fleet, and
   * only the collector knows what its own calls cost — so the scheduler
   * reports the count and the collector does the arithmetic.
   *
   * Grouped by tenant **and secret ref**, because the rate limit belongs to
   * the token rather than the tenant: one tenant holding several credentials
   * would otherwise have each group claim a full budget against a limit they
   * actually share.
   */
  peersDue?: number;
}

export interface SourceCollector {
  readonly source: string;

  /** Normalize a verified raw webhook body into one or more canonical envelopes. */
  normalizeWebhook(
    connection: Connection,
    rawBody: Buffer,
    headers: Record<string, unknown>,
  ): Promise<CanonicalEnvelope[]>;

  /** Pull changes since the connection's cursor (backfill / reconciliation). */
  poll(connection: Connection, options?: PollOptions): Promise<PollResult>;
}

/** Convenience base with shared helpers; concrete collectors extend per source. */
export abstract class BaseSourceCollector implements SourceCollector {
  abstract readonly source: string;
  abstract normalizeWebhook(
    connection: Connection,
    rawBody: Buffer,
    headers: Record<string, unknown>,
  ): Promise<CanonicalEnvelope[]>;
  abstract poll(
    connection: Connection,
    options?: PollOptions,
  ): Promise<PollResult>;

  protected nowIso(): string {
    return new Date().toISOString();
  }
}
