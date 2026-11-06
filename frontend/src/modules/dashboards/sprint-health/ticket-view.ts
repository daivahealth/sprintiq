import type {
  CodeState,
  DataGapKind,
  JiraStatusBucket,
  SprintTicketRow,
} from '../useInsights';

/**
 * The Sprint work ticket table's filtering and sorting, kept out of the
 * component so the rules are testable without a DOM.
 */

export const BUCKET_ORDER: Record<JiraStatusBucket, number> = {
  'in-progress': 0,
  todo: 1,
  done: 2,
};

export const CODE_ORDER: Record<CodeState, number> = {
  merged: 0,
  'in-review': 1,
  committed: 2,
  none: 3,
};

/** Gaps that are context, not a record to fix — they don't make a row "needs update". */
export const INFO_GAPS: DataGapKind[] = ['in-qa', 'no-code-linked'];

export const needsUpdate = (t: SprintTicketRow) =>
  (t.gaps ?? []).some((g) => !INFO_GAPS.includes(g));

/** Stands in for "no epic" in the epic filter — a real key never looks like this. */
export const NO_EPIC = '(none)';

/** One value per axis; axes combine with AND. */
export interface TicketFilter {
  bucket?: JiraStatusBucket;
  code?: CodeState;
  epic?: string;
  gap?: DataGapKind | 'needs-update';
}

/** `default` keeps the backend's order: in progress, to do, done, then by key. */
export type SortKey =
  'default' | 'key' | 'status' | 'points' | 'assignee' | 'code' | 'commits';

export function filterTickets(
  tickets: SprintTicketRow[],
  filter: TicketFilter,
): SprintTicketRow[] {
  return tickets.filter(
    (t) =>
      (!filter.bucket || t.bucket === filter.bucket) &&
      (!filter.code || t.code.state === filter.code) &&
      (!filter.epic || (t.epicKey ?? NO_EPIC) === filter.epic) &&
      (!filter.gap ||
        (filter.gap === 'needs-update'
          ? needsUpdate(t)
          : (t.gaps ?? []).includes(filter.gap))),
  );
}

/**
 * Sorts by one column. Ties fall back to the ticket key ascending, in both
 * directions, so a flip of direction never reshuffles equal rows.
 */
export function sortTickets(
  tickets: SprintTicketRow[],
  sort: { key: SortKey; desc: boolean },
): SprintTicketRow[] {
  if (sort.key === 'default') return tickets;
  const value = (t: SprintTicketRow): number | string => {
    switch (sort.key) {
      case 'key':
        return t.key;
      case 'status':
        return BUCKET_ORDER[t.bucket];
      case 'points':
        // Unestimated sorts below zero points, not among them.
        return t.storyPoints ?? -1;
      case 'assignee':
        return t.assigneeName ?? '';
      case 'code':
        return CODE_ORDER[t.code.state];
      case 'commits':
        return t.code.commits;
      default:
        return 0;
    }
  };
  const byKey = (a: SprintTicketRow, b: SprintTicketRow) =>
    a.key.localeCompare(b.key, undefined, { numeric: true });
  return [...tickets].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const c =
      typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), undefined, { numeric: true });
    return (sort.desc ? -c : c) || byKey(a, b);
  });
}
