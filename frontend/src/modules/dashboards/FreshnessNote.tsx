import { StatusDot } from '../../components/ui';
import { timeAgo } from '../../lib/utils';
import { useFreshness } from './useInsights';

/**
 * "Data as of …" beside the scope, on every board (DASHBOARDS.md §1.5,
 * METRICS.md §9).
 *
 * Ingestion is poll-only on a 4-hour default interval, so every number on
 * screen can be hours old while the page itself was rendered a second ago.
 * Without this the UI implies live data it does not have — and a failing
 * connection is worse than merely stale, because its slice is frozen at an
 * age nothing on the page would otherwise reveal.
 *
 * Reports the OLDEST sync across active connections, not the newest: a board
 * mixes Jira and GitHub facts, so the freshest source says nothing about the
 * number next to it.
 */

/** Beyond this, "a while ago" is worth flagging rather than just stating. */
const STALE_WARN_SECONDS = 6 * 60 * 60;

export function FreshnessNote() {
  const { data } = useFreshness();
  if (!data) {
    return null;
  }

  const { lastSyncAt, staleSeconds, neverSynced, failing } = data;
  const hasProblem = failing.length > 0 || neverSynced > 0;
  const stale = staleSeconds !== null && staleSeconds > STALE_WARN_SECONDS;

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-2 text-xs text-fg-faint">
      <StatusDot
        tone={hasProblem ? 'bad' : stale ? 'warn' : 'good'}
        aria-hidden
      />
      <span>
        {lastSyncAt
          ? `Data as of ${timeAgo(lastSyncAt)}`
          : 'No source has synced yet'}
      </span>

      {data.sources.length > 1 && lastSyncAt && (
        <span className="text-fg-faint">
          (
          {data.sources
            .map(
              (s) =>
                `${s.sourceSystem} ${s.lastSyncAt ? timeAgo(s.lastSyncAt) : 'never'}`,
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
