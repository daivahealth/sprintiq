import { StatusDot } from '../../components/ui';
import { timeAgo } from '../../lib/utils';
import { useFreshness } from './useInsights';

/**
 * "Data complete through …" beside the scope, on every board (DASHBOARDS.md
 * §1.5, METRICS.md §9).
 *
 * Reports COMPLETENESS, not contact. The distinction is the whole point: a
 * connection can reach GitHub every five minutes while eighty pages behind in
 * its backfill, so "synced 2 minutes ago" was true and useless — it described
 * the collector's health, not the data's coverage. `collectedThroughAt` is the
 * point in source time every change has actually been collected up to, which
 * is what a number on this screen is really claiming.
 *
 * Three states, deliberately distinct rather than folded into one timestamp:
 *  - complete through T — the honest, ordinary case.
 *  - still backfilling — no completeness exists yet at all. Reporting the
 *    finished connections' watermark here would claim a coverage the rest of
 *    the data predates.
 *  - failing / never synced — that slice is frozen at an unknown age.
 *
 * The bound is the OLDEST across active connections: a board mixes Jira and
 * GitHub facts, so the freshest source says nothing about the number beside it.
 */

/** Beyond this, being behind is worth flagging rather than just stating. */
const BEHIND_WARN_SECONDS = 6 * 60 * 60;

export function FreshnessNote() {
  const { data } = useFreshness();
  if (!data) {
    return null;
  }

  const { collectedThroughAt, behindSeconds, incomplete, neverSynced, failing } =
    data;
  const hasProblem = failing.length > 0 || neverSynced > 0;
  const behind = behindSeconds !== null && behindSeconds > BEHIND_WARN_SECONDS;

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-2 text-xs text-fg-faint">
      <StatusDot
        tone={hasProblem ? 'bad' : incomplete > 0 || behind ? 'warn' : 'good'}
        aria-hidden
      />
      <span>
        {collectedThroughAt
          ? `Data complete through ${timeAgo(collectedThroughAt)}`
          : incomplete > 0
            ? 'Still collecting history — coverage is incomplete'
            : 'No source has synced yet'}
      </span>

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

      {incomplete > 0 && (
        <span className="text-warning-fg">
          {incomplete} connection{incomplete === 1 ? '' : 's'} still backfilling
          — history before their window is not in yet
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
