/** One page of the check-ins grid: an IST date range and its display label. */
export interface CheckInPage {
  from: string;
  to: string;
  label: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_DAYS = 7;

/**
 * Splits a sprint's elapsed window into seven-day pages for the check-ins
 * grid.
 *
 * `sprintFrom`/`sprintTo` MUST be the elapsed window the backend reports
 * (`CheckInsView.sprintFrom`/`sprintTo` — `min(sprint.endAt, now)`), not the
 * sprint's full planned bounds. Built from full bounds, this would offer a
 * page for days a running sprint hasn't reached yet; the backend clamps such
 * a request to a window with no data, and the grid comes back empty.
 *
 * The last page is left short rather than padded to a full week: a padded
 * page would show days the sprint never ran as empty columns, which reads as
 * "nobody moved anything" rather than "not a sprint day".
 */
export function checkInPages(sprintFrom: string, sprintTo: string): CheckInPage[] {
  if (!sprintFrom || !sprintTo) {
    return [];
  }

  const from = new Date(`${sprintFrom}T00:00:00.000Z`);
  const to = new Date(`${sprintTo}T00:00:00.000Z`);
  const totalDays = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (totalDays <= 0) {
    return [];
  }

  const pageCount = Math.ceil(totalDays / PAGE_DAYS);
  const pages: CheckInPage[] = [];
  for (let i = 0; i < pageCount; i++) {
    const pageFrom = new Date(from.getTime() + i * PAGE_DAYS * DAY_MS);
    const remainingDays = totalDays - i * PAGE_DAYS;
    const pageLenDays = Math.min(PAGE_DAYS, remainingDays);
    const pageTo = new Date(pageFrom.getTime() + (pageLenDays - 1) * DAY_MS);
    pages.push({
      from: dateKey(pageFrom),
      to: dateKey(pageTo),
      label: `Week ${i + 1} of ${pageCount}`,
    });
  }
  return pages;
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
