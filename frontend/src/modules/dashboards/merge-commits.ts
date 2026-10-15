/**
 * The one sentence every activity view uses to disclose the merge commits it
 * left out (METRICS.md §0).
 *
 * Merges are excluded from commit counts and LOC because GitHub reports a merge
 * commit's lines as the merged branch's lines again, credited to whoever merged.
 * A view that drops them says how many, so a smaller number than the reader saw
 * yesterday reads as a corrected count rather than as less work.
 *
 * `null` when there is nothing to say: none excluded, or an older API that
 * does not report the count (absent means unknown, never zero).
 */
export function mergeExclusionNote(count: number | undefined): string | null {
  if (!count) {
    return null;
  }
  return `${count.toLocaleString()} merge commit${count === 1 ? ' is' : 's are'} not counted — a merge's lines are the merged branch's lines again, so counting them would double that work and credit it to whoever merged.`;
}
