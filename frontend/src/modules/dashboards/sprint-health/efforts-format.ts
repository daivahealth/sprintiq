import type { EffortsView } from '../useInsights';

/**
 * Logged seconds → "2h 30m", "45m", "8h". Minutes are rounded; anything
 * logged under half a minute still shows as "<1m" rather than "0m", so a cell
 * with a real (if tiny) worklog never reads as empty.
 */
export function formatLogged(seconds: number): string {
  if (seconds <= 0) return '0';
  const minutes = Math.round(seconds / 60);
  if (minutes === 0) return '<1m';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * The page's disclosures as sentences, only for the ones that apply — each is
 * a reason a cell could understate, and saying nothing when nothing applies
 * keeps the ones that do from being skimmed past.
 */
export function effortsDisclosures(view: EffortsView): string[] {
  const out: string[] = [];
  const { roster, disclosures } = view;
  if (roster.notShown > 0) {
    out.push(
      `Showing the first ${roster.shown} of ${roster.shown + roster.notShown} tracked developers, A–Z.`,
    );
  }
  if (roster.unresolved > 0) {
    out.push(
      `${roster.unresolved} tracked ${plural(roster.unresolved, 'entry', 'entries')} could not be matched to a known developer and ${roster.unresolved === 1 ? 'is' : 'are'} not shown.`,
    );
  }
  if (roster.suppressed > 0) {
    out.push(
      `${roster.suppressed} tracked ${plural(roster.suppressed, 'entry is', 'entries are')} excluded (bots, admin exclusions or Watchlist exclusions).`,
    );
  }
  if (disclosures.itemsWithoutWorklogSnapshot > 0) {
    out.push(
      `Worklogs not yet collected for ${disclosures.itemsWithoutWorklogSnapshot} of ${disclosures.itemsInScope} sprint ${plural(disclosures.itemsInScope, 'item', 'items')} — hours may be understated until the backfill catches up.`,
    );
  }
  if (disclosures.unattributedWorklogs > 0) {
    out.push(
      `${disclosures.unattributedWorklogs} ${plural(disclosures.unattributedWorklogs, 'worklog', 'worklogs')} in this range could not be matched to a developer.`,
    );
  }
  return out;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
