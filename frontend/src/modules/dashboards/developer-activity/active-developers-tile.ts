/**
 * The Overview's headline tile (2026-10-27): active developers counted against
 * the Tracked Developers list (admin-editable, read live) — the team the board
 * is about — rather than every identity GitHub has ever shown (bots, excluded
 * accounts and leavers included), which made "N / 117" a meaningless
 * denominator.
 *
 * Only tracked developers appear on it; people outside the list are neither
 * named nor counted. With no list configured, or on an API that predates the
 * field, the count stands alone and says why.
 */
export function activeDevelopersTile(totals: {
  developersWithSignal: number;
  trackedDevelopers?: number | null;
}): { label: string; value: string; hint: string } {
  const tracked = totals.trackedDevelopers;
  if (tracked === undefined || tracked === null) {
    return {
      label: 'Active developers',
      value: String(totals.developersWithSignal),
      hint:
        tracked === null
          ? 'everyone with a commit that changed files — add people on Developers with No GH-Recorded Activity to count your team'
          : 'commit that changed files in this window',
    };
  }
  // "Commit that changed files" since 2026-11-04: PRs and merge commits alone
  // no longer count (ADR-0009 amendment, backend `isSignalCommit`).
  return {
    label: 'Active developers',
    value: `${totals.developersWithSignal} / ${tracked}`,
    hint: 'tracked developers with a commit that changed files',
  };
}
