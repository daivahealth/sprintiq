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
});
