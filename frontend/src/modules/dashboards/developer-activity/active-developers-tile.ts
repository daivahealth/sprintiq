/**
 * The Overview's headline tile (2026-10-27): active developers counted against
 * the Tracked Developers list — the team the board is about — rather than
 * every identity GitHub has ever shown (bots, excluded accounts and leavers
 * included), which made "N / 117" a meaningless denominator.
 *
 * Active people who are not on the list are named in the hint, never dropped
 * silently. With no list configured, or on an API that predates the field,
 * the count stands alone and says why.
 */
export function activeDevelopersTile(
  totals: { developersWithSignal: number; trackedDevelopers?: number | null },
  notTracked: readonly unknown[] | undefined,
): { label: string; value: string; hint: string } {
  const tracked = totals.trackedDevelopers;
  if (tracked === undefined || tracked === null) {
    return {
      label: 'Active developers',
      value: String(totals.developersWithSignal),
      hint:
        tracked === null
          ? 'everyone with a commit or PR — add people on Tracked Developers to count your team'
          : 'commit or PR in this window',
    };
  }
  const outside = notTracked?.length ?? 0;
  return {
    label: 'Active developers',
    value: `${totals.developersWithSignal} / ${tracked}`,
    hint: [
      'tracked developers with a commit or PR',
      outside > 0 ? `+${outside} active, not tracked` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}
