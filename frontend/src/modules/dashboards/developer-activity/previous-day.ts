/** `GET /dashboards/developer-activity/watchlist/previous-day` (admin only). */
export interface PreviousDayView {
  day: string;
  outcome: 'named' | 'all_clear' | 'withheld';
  withheld: { outcome: string; detail: string } | null;
  ruleText: string;
  rosterCount: number;
  flagged: { developer: string; displayName: string }[];
  unresolved: { developer: string; addedAs: string }[];
  incomplete: { developer: string; displayName: string }[];
  unattributedCommits: number;
  lastDigestRun: {
    outcome: string;
    deliveredAt: string | null;
    flaggedCount: number;
  } | null;
  namedThenNowActive: { developer: string; displayName: string }[];
}

/** "Fri 16 Oct" for an IST date key. */
export function formatReportedDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** The card's one-line summary of the day. */
export function previousDayHeadline(view: PreviousDayView): string {
  const day = formatReportedDay(view.day);
  switch (view.outcome) {
    case 'named':
      return `${view.flagged.length} of ${view.rosterCount} tracked developer${view.rosterCount === 1 ? '' : 's'} showed no delivery signal on ${day}`;
    case 'all_clear':
      return `Every evaluable tracked developer showed a delivery signal on ${day}`;
    case 'withheld':
      return `Names withheld for ${day} — the data can't vouch for the day yet`;
  }
}

/**
 * Why names are withheld, in words. The digest's outcome codes are lineage
 * for the run table, not text for a reader; the detail carries specifics.
 */
export function withheldExplanation(
  withheld: PreviousDayView['withheld'],
): string | null {
  if (!withheld) return null;
  const why: Record<string, string> = {
    withheld_stale_data:
      'collection is behind or failing, so a missing commit may simply not have arrived',
    withheld_truncated_read:
      "the day's commit read hit its ceiling, so some commits weren't counted",
    withheld_implausible:
      'an implausibly large share of the roster would be named, which usually means a data problem',
    withheld_unevaluable: 'no one on the roster could be evaluated',
  };
  return `${why[withheld.outcome] ?? 'the data cannot vouch for the day'} (${withheld.detail})`;
}

/** Link to one person's Developer page, scoped to the reported day. */
export function developerDayHref(developer: string, day: string): string {
  const params = new URLSearchParams({
    developer,
    window: 'custom',
    from: day,
    to: day,
  });
  return `../developer?${params.toString()}`;
}
