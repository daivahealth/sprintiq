/** One page of the check-ins grid: an IST date range and its display label. */
export interface CheckInPage {
  from: string;
  to: string;
  label: string;
  /** 1-based sprint day of `from` — "sprint days 1–7". */
  firstDay: number;
  /** 1-based sprint day of `to`. */
  lastDay: number;
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
 * Both are IST date keys (`YYYY-MM-DD`), the same unit as `CheckInsView.days`
 * — NOT ISO instants. This function does no timezone conversion of its own:
 * it parses each key as UTC midnight purely as a stable anchor for day-count
 * arithmetic, and every value it returns is sliced back to the same
 * `YYYY-MM-DD` form. Passing an ISO instant here (e.g. straight off
 * `Date#toISOString()`) is a caller bug, not a case this function handles.
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
      firstDay: i * PAGE_DAYS + 1,
      lastDay: i * PAGE_DAYS + pageLenDays,
    });
  }
  return pages;
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Rows shown per page in the board's lists (developers, RCs, stories). */
export const LIST_PAGE_SIZE = 10;

/** One page of a client-side list: its rows and where it sits in the whole. */
export interface ListPage<T> {
  items: T[];
  /** 0-based index of the page actually returned (clamped into range). */
  page: number;
  pageCount: number;
  /** 1-based position of the first/last row on this page; 0/0 when empty. */
  first: number;
  last: number;
  total: number;
}

/**
 * Slices `items` to one page of `size` rows. An out-of-range `page` is
 * clamped rather than returning an empty page — the list can shrink under
 * a held page index (another check-in week, a refetch), and an empty page
 * with rows on earlier pages would read as "nothing here". Order is the
 * caller's: this never sorts, so a backend order (e.g. productivity's grade
 * order, never LOC) is preserved across pages.
 */
export function listPage<T>(items: readonly T[], page: number, size = LIST_PAGE_SIZE): ListPage<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(0, Math.floor(page)), pageCount - 1);
  const start = p * size;
  const slice = items.slice(start, start + size);
  return {
    items: slice,
    page: p,
    pageCount,
    first: total === 0 ? 0 : start + 1,
    last: start + slice.length,
    total,
  };
}
