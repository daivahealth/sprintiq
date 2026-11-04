/**
 * Merge commits are excluded from LOC and from authorship commit counts
 * (METRICS.md §0).
 *
 * GitHub reports a merge commit's stats as its diff against the FIRST parent —
 * the merged branch's lines a second time, credited to whoever merged. Measured
 * on the reference tenant (2026-10-15): 21,221 of 70,569 commits were merges,
 * carrying 43% of all changed lines. Counting them doubles a merged branch's
 * volume and moves it onto the merger.
 *
 * Excluded from *volume*, and — since 2026-11-04 (ADR-0009 amendment) — from
 * the shared "active" definition too (`isSignalCommit` / `activeDeveloperSet`,
 * which the Overview and the daily digest share): merging a PR is not counted
 * as a day's activity. Every view that drops them discloses how many it
 * dropped.
 *
 * `parentCount` null means unknown (not yet backfilled, or GitHub no longer
 * answers for the commit) and is treated as NOT a merge — the conservative
 * reading, which leaves the figure as it was before the exclusion existed.
 */
export function isMergeCommit(commit: {
  parentCount?: number | null;
}): boolean {
  return (commit.parentCount ?? 0) > 1;
}

/** Splits commits into the authored ones that count and the merges that don't. */
export function partitionMerges<T extends { parentCount?: number | null }>(
  commits: T[],
): { authored: T[]; mergeCommits: number } {
  const authored = commits.filter((c) => !isMergeCommit(c));
  return { authored, mergeCommits: commits.length - authored.length };
}
