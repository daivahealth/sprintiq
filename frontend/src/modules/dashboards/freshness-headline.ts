/**
 * The one-line verdict at the head of the freshness note.
 *
 * Pulled out as a pure function because it got this wrong in a way nobody
 * could see from the code: the "no source has synced yet" branch fired on a
 * missing collection *watermark*, while the very same payload reported
 * `neverSynced: 0` and a real `lastSyncAt`. The banner contradicted its own
 * data, on a component whose entire job is telling the reader how much to
 * trust the numbers beside it.
 *
 * "Never synced" and "synced, but no watermark" are different facts with
 * different remedies — the first means a credential or a connection that has
 * never run, the second means collection is running but has not reported how
 * far it has reached.
 */
export interface FreshnessHeadlineInput {
  /** Newest point collection has reached, when any source reports one. */
  collectedThroughAt: string | null;
  /** Whether an in-progress backfill actually clips this board's window. */
  backfillAffectsThisBoard: boolean;
  /** Connections that have never completed a sync. */
  neverSynced: number;
  /** Newest successful sync across sources, whatever it collected. */
  lastSyncAt: string | null;
}

export type FreshnessHeadline =
  | { kind: 'complete'; through: string }
  | { kind: 'backfilling' }
  | { kind: 'never-synced' }
  | { kind: 'no-watermark'; lastSyncAt: string };

export function freshnessHeadline(
  input: FreshnessHeadlineInput,
): FreshnessHeadline {
  const {
    collectedThroughAt,
    backfillAffectsThisBoard,
    neverSynced,
    lastSyncAt,
  } = input;

  if (collectedThroughAt) {
    return { kind: 'complete', through: collectedThroughAt };
  }
  if (backfillAffectsThisBoard) {
    return { kind: 'backfilling' };
  }
  // Only claim nothing has ever synced when that is what the data says.
  if (neverSynced > 0 || !lastSyncAt) {
    return { kind: 'never-synced' };
  }
  return { kind: 'no-watermark', lastSyncAt };
}
