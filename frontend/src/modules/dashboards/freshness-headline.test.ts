import { describe, expect, it } from 'vitest';
import { freshnessHeadline } from './freshness-headline';

const base = {
  collectedThroughAt: null,
  backfillAffectsThisBoard: false,
  neverSynced: 0,
  lastSyncAt: null,
};

describe('freshnessHeadline', () => {
  it('reports the collected-through point when one exists', () => {
    expect(
      freshnessHeadline({
        ...base,
        collectedThroughAt: '2026-09-15T10:00:00Z',
      }),
    ).toEqual({ kind: 'complete', through: '2026-09-15T10:00:00Z' });
  });

  it('reports backfilling when an unfinished backfill clips this board', () => {
    expect(
      freshnessHeadline({ ...base, backfillAffectsThisBoard: true }),
    ).toEqual({ kind: 'backfilling' });
  });

  it('says nothing has synced only when nothing has', () => {
    expect(freshnessHeadline({ ...base, neverSynced: 3 })).toEqual({
      kind: 'never-synced',
    });
    expect(freshnessHeadline(base)).toEqual({ kind: 'never-synced' });
  });

  /**
   * The defect this function exists for. The live payload was:
   *
   *   neverSynced: 0, lastSyncAt: "2026-09-15…", collectedThroughAt: null
   *
   * and the banner announced "No source has synced yet" across the top of the
   * board — contradicting two fields of the object it was rendering.
   */
  it('does not claim "never synced" when a sync has plainly happened', () => {
    const headline = freshnessHeadline({
      ...base,
      neverSynced: 0,
      lastSyncAt: '2026-09-15T10:55:33.969Z',
    });

    expect(headline).toEqual({
      kind: 'no-watermark',
      lastSyncAt: '2026-09-15T10:55:33.969Z',
    });
    expect(headline.kind).not.toBe('never-synced');
  });

  // A watermark outranks the rest: if collection has reported how far it
  // reached, that is the most useful thing to say, whatever else is true.
  it('prefers the watermark even when connections have never synced', () => {
    expect(
      freshnessHeadline({
        ...base,
        collectedThroughAt: '2026-09-15T10:00:00Z',
        neverSynced: 5,
      }),
    ).toMatchObject({ kind: 'complete' });
  });
});
