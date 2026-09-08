import { describe, expect, it } from 'vitest';
import { checkInPages } from './pager';

describe('checkInPages', () => {
  it('splits a sprint into seven-day pages', () => {
    const pages = checkInPages('2026-08-25', '2026-09-05');
    expect(pages).toEqual([
      { from: '2026-08-25', to: '2026-08-31', label: 'Week 1 of 2' },
      { from: '2026-09-01', to: '2026-09-05', label: 'Week 2 of 2' },
    ]);
  });

  // The last page is short when the sprint does not divide by seven. Padding
  // it to a full week would show days the sprint never ran as empty columns —
  // zeros that mean "not a sprint day" and read as "nobody moved anything".
  it('leaves the final page short rather than padding past the sprint end', () => {
    const pages = checkInPages('2026-08-25', '2026-08-27');
    expect(pages).toEqual([
      { from: '2026-08-25', to: '2026-08-27', label: 'Week 1 of 1' },
    ]);
  });

  it('returns a single page for a one-day sprint', () => {
    expect(checkInPages('2026-08-25', '2026-08-25')).toHaveLength(1);
  });

  it('returns no pages when the sprint has no dates', () => {
    expect(checkInPages('', '')).toEqual([]);
  });

  // Regression: `CheckInsView.sprintFrom`/`sprintTo` were briefly returned as
  // full ISO instants (`win.from.toISOString()`), not IST date keys. This
  // function assumed a bare `YYYY-MM-DD`, so concatenating a second
  // `T00:00:00.000Z` onto an instant produced an invalid Date, the arithmetic
  // went NaN, and every real sprint silently paged to zero pages. The
  // contract is now IST date keys throughout — this uses the exact values a
  // running sprint produces on the wire (sprint-health-detail.service.spec.ts:
  // startAt 2026-08-25, endAt 2026-09-05, "now" 2026-08-31 -> elapsed window
  // sprintFrom '2026-08-25', sprintTo '2026-08-31') so this class of "the
  // test used a shape the API never sends" cannot recur silently.
  it('consumes the real IST-date-key shape CheckInsView reports for a running sprint', () => {
    const pages = checkInPages('2026-08-25', '2026-08-31');
    expect(pages).toEqual([
      { from: '2026-08-25', to: '2026-08-31', label: 'Week 1 of 1' },
    ]);
  });
});
