import { StatusDot } from '../../components/ui';
import { timeAgo } from '../../lib/utils';
import { useFreshness } from './useInsights';

/**
 * "Data complete for this range" beside the scope, on every board
 * (DASHBOARDS.md §1.5, METRICS.md §9).
 *
 * Judges the window ACTUALLY ON SCREEN, not the whole dataset. That is the
 * point: collection is a range, `[collectedBackTo, collectedThroughAt]`, and a
 * board showing the last 7 days over a complete last 7 days is complete —
 * however far a 12-month historical walk still has to go. Reporting global
 * completeness instead meant a tenant mid-backfill could say nothing but
 * "incomplete" for days, on boards whose numbers were entirely correct. An
 * unnecessary warning is not free: it teaches people to ignore the real ones.
 *
 * So there are two independent questions, and each is only raised when it
 * actually applies to this board:
 *  - **Does the window reach past the data?** `collectedBackTo > from` — say
 *    so, with the date history actually starts, because those numbers really
 *    are short.
 *  - **Is the recent end behind?** `collectedThroughAt` old — say so.
 *
 * Boards without a time window (Sprint Health, Sprint Risk) pass no
 * `windowFrom` and get the plain statement.
 */

/** Beyond this, being behind is worth flagging rather than just stating. */
const BEHIND_WARN_SECONDS = 6 * 60 * 60;

export function FreshnessNote({ windowFrom }: { windowFrom?: string }) {
  const { data } = useFreshness();
  if (!data) {
    return null;
  }

  const { collectedThroughAt, collectedBackTo, behindSeconds, incomplete } =
    data;
  const { neverSynced, failing } = data;

  // Does this board's window reach past what has been collected? Only
  // answerable when the board has a window AND a lower bound exists.
  const windowStartsBeforeData =
    windowFrom != null &&
    collectedBackTo != null &&
    new Date(collectedBackTo) > new Date(windowFrom);

  const behind = behindSeconds !== null && behindSeconds > BEHIND_WARN_SECONDS;
  const hasProblem = failing.length > 0 || neverSynced > 0;
  // Backfill only matters to THIS board if it actually clips its window, or if
  // nothing has been collected at all yet.
  const backfillAffectsThisBoard =
    incomplete > 0 && (windowFrom == null || collectedBackTo == null);

  const tone = hasProblem
    ? 'bad'
    : windowStartsBeforeData || behind || backfillAffectsThisBoard
      ? 'warn'
      : 'good';

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-2 text-xs text-fg-faint">
      <StatusDot tone={tone} aria-hidden />

      <span>
        {collectedThroughAt
          ? `Data complete through ${timeAgo(collectedThroughAt)}`
          : backfillAffectsThisBoard
            ? 'Still collecting history — coverage is incomplete'
            : 'No source has synced yet'}
      </span>

      {/* The one that matters for a windowed board: the range on screen
          extends past where collection has reached, so these numbers are
          genuinely short and by how much is stated. */}
      {windowStartsBeforeData && collectedBackTo && (
        <span className="text-warning-fg">
          — history only goes back to{' '}
          {new Date(collectedBackTo).toLocaleDateString()}, so earlier days in
          this range are still being collected
        </span>
      )}

      {data.sources.length > 1 && (
        <span className="text-fg-faint">
          (
          {data.sources
            .map(
              (s) =>
                `${s.sourceSystem} ${
                  s.collectedThroughAt
                    ? timeAgo(s.collectedThroughAt)
                    : 'backfilling'
                }`,
            )
            .join(' · ')}
          )
        </span>
      )}

      {neverSynced > 0 && (
        <span className="text-danger">
          {neverSynced} connection{neverSynced === 1 ? '' : 's'} never synced —
          that data is missing, not just old
        </span>
      )}

      {failing.length > 0 && (
        <span className="text-danger">
          {failing.length} connection{failing.length === 1 ? '' : 's'} failing (
          {failing.map((f) => f.name).join(', ')}) — those numbers are frozen at
          an unknown age
        </span>
      )}
    </p>
  );
}
