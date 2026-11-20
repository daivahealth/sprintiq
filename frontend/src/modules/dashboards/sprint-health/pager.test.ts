import { describe, expect, it } from 'vitest';
import { checkInPages, filterList, listPage } from './pager';

describe('checkInPages', () => {
  it('splits a sprint into seven-day pages', () => {
    const pages = checkInPages('2026-08-25', '2026-09-05');
    expect(pages).toEqual([
      { from: '2026-08-25', to: '2026-08-31', label: 'Week 1 of 2', firstDay: 1, lastDay: 7 },
      { from: '2026-09-01', to: '2026-09-05', label: 'Week 2 of 2', firstDay: 8, lastDay: 12 },
    ]);
  });

  // The last page is short when the sprint does not divide by seven. Padding
  // it to a full week would show days the sprint never ran as empty columns —
  // zeros that mean "not a sprint day" and read as "nobody moved anything".
  it('leaves the final page short rather than padding past the sprint end', () => {
    const pages = checkInPages('2026-08-25', '2026-08-27');
    expect(pages).toEqual([
      { from: '2026-08-25', to: '2026-08-27', label: 'Week 1 of 1', firstDay: 1, lastDay: 3 },
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
      { from: '2026-08-25', to: '2026-08-31', label: 'Week 1 of 1', firstDay: 1, lastDay: 7 },
    ]);
  });
});

describe('listPage', () => {
  const rows = Array.from({ length: 23 }, (_, i) => i);

  it('returns ten rows per page in the caller’s order', () => {
    const p = listPage(rows, 1);
    expect(p.items).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(p).toMatchObject({ page: 1, pageCount: 3, first: 11, last: 20, total: 23 });
  });

  it('leaves the last page short', () => {
    expect(listPage(rows, 2)).toMatchObject({ items: [20, 21, 22], first: 21, last: 23 });
  });

  // The list can shrink under a held page index (another check-in week).
  it('clamps an out-of-range page instead of returning an empty one', () => {
    expect(listPage(rows, 9).page).toBe(2);
    expect(listPage(rows.slice(0, 4), 2)).toMatchObject({ page: 0, items: [0, 1, 2, 3] });
    expect(listPage(rows, -1).page).toBe(0);
  });

  it('reports a single empty page for an empty list', () => {
    expect(listPage([], 0)).toMatchObject({ items: [], page: 0, pageCount: 1, first: 0, last: 0 });
  });
});

describe('filterList', () => {
  const people = ['Amit Prasad', 'Priya Nair', 'Arun Kumar'];
  const self = (s: string) => s;

  it('keeps everything for a blank query', () => {
    expect(filterList(people, '   ', self)).toEqual(people);
  });

  it('matches every term, case-insensitively, in the caller’s order', () => {
    expect(filterList(people, 'PR', self)).toEqual(['Amit Prasad', 'Priya Nair']);
    expect(filterList(people, 'amit pr', self)).toEqual(['Amit Prasad']);
    expect(filterList(people, 'zed', self)).toEqual([]);
  });
});
