import {
  formatDateKey,
  rangeEndsInPast,
  type ActivityRange,
} from '../activity-range';

/**
 * "This panel describes today, not the range you picked."
 *
 * Some figures here are current state with no collected history behind them —
 * today's Jira assignment, the open-PR queue, live exclusions. On a range
 * ending in the past they cannot answer for that past, and the honest move is
 * to say so rather than to omit them or to let them pass as historical.
 *
 * It matters most for "committing, nothing assigned", which would otherwise
 * join April's commits to today's Jira board and present the pair as one
 * finding — the same inversion §4.4.5 forbids in its other direction.
 *
 * Renders nothing for a preset, where every lens already shares one moment.
 */
export function CurrentLensNote({
  range,
  lens,
}: {
  range: ActivityRange;
  lens: string;
}) {
  if (range.kind !== 'custom' || !rangeEndsInPast(range)) {
    return null;
  }
  return (
    <p className="rounded-md border border-border bg-subtle p-2.5 text-xs text-fg-subtle">
      {lens} is current, not as of {formatDateKey(range.to)} — we keep no
      history for it, so this reads as of today while the rest of the range
      reads to {formatDateKey(range.to)}.
    </p>
  );
}
