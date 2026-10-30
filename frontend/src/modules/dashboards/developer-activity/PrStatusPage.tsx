import { Link } from 'react-router-dom';
import {
  Card,
  ProvenanceNote,
  TableBodyRow,
  TableHeadRow,
} from '../../../components/ui';
import { cn, timeAgo } from '../../../lib/utils';
import { usePrStatus, type PrStatusView } from '../useInsights';
import { ErrorCard, LoadingCard, Stat } from '../widgets';
import { CurrentLensNote } from './CurrentLensNote';
import { developerHref } from './developer-href';
import { formatWait } from './wait-format';
import { useSectionRange } from './window';

/**
 * Engineering Activity §PR Status (DASHBOARDS.md §4.4.4).
 *
 * Owns what is actionable now: which changes are waiting, and how review load
 * is spread. It deliberately reports NO cycle-time percentiles — those are
 * Efficiency's, computed over a merged-only denominator, and restating them
 * here over a different denominator would put two numbers for one concept on
 * two screens and invite the reader to reconcile a gap that is by design.
 *
 * "Reviewed" means reviewed by a person other than the author. A bot's review,
 * or the author replying in their own thread, leaves a PR in the queue.
 *
 * Every figure follows the range (2026-10-30). The queue is the PRs OPENED in
 * the range that are still open today; open PRs from outside it are counted
 * beside the tiles, so widening the range is the way to an old change, never
 * a guess that it might be missing.
 */

/** What a tile's hint adds when automation was left out of its figure. */
function excludedHint(parts: [number, string][]): string {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(', ');
}

export function PrStatusPage() {
  const { range } = useSectionRange();
  const query = usePrStatus(range);
  const d = query.data;

  // Only before the first answer: a range change keeps the previous figures
  // on screen (dimmed) until the new range's arrive, rather than blanking the
  // page to a spinner.
  if (query.isLoading) return <LoadingCard />;
  if (query.isError) return <ErrorCard error={query.error} />;
  if (!d) return null;

  const reviewsExcluded = excludedHint([
    [d.totals.botReviews, 'bot'],
    [d.totals.selfReviews, 'self-reviews'],
  ]);

  return (
    <div
      className={cn(
        'space-y-6 transition-opacity',
        query.isPlaceholderData && 'opacity-60',
      )}
      aria-busy={query.isPlaceholderData}
    >
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Open PRs"
          value={d.totals.open}
          hint={
            d.totals.botAuthored > 0
              ? `opened this window · ${d.totals.botAuthored} raised by bots not counted`
              : 'opened this window, still open'
          }
        />
        {/* `≥` and "calendar": the code compares with >=, and the clock runs
            through nights and weekends — a PR opened Friday evening is past
            it by Sunday. Saying so is cheaper than a reader discovering it. */}
        <Stat
          label={`Waiting ≥ ${d.thresholdHours}h`}
          value={d.totals.waitingOverThreshold}
          hint="no review yet, calendar hours"
        />
        <Stat
          label="Never reviewed"
          value={d.totals.neverReviewed}
          hint={
            d.totals.botReviewedOnly > 0
              ? `no person has reviewed · ${d.totals.botReviewedOnly} reviewed only by a bot`
              : 'no person has reviewed'
          }
        />
        {/* Windowed by when the review was submitted, not when the PR was
            opened — the one tile whose window means something different, so
            its hint keeps saying "this window" whatever else it carries. */}
        <Stat
          label="Reviews given"
          value={d.totals.reviewsGiven}
          hint={
            reviewsExcluded
              ? `this window · ${reviewsExcluded} excluded`
              : 'by people, this window'
          }
        />
      </div>

      <QueueScopeNote d={d} />

      {/* The range picks WHICH PRs; whether they are still open, reviewed,
          and how long they have waited is today's answer — there is no
          collected history of a PR's state to answer for the range's end. */}
      <CurrentLensNote
        range={range}
        lens="Whether those PRs are still open or reviewed, and how long they have waited,"
      />

      <Card className="space-y-3">
        <div>
          <h3 className="font-semibold text-fg">Waiting on review</h3>
          <p className="text-xs text-fg-subtle">
            Oldest first. A review-capacity signal — a long queue usually points
            to a project needing reviewer bandwidth, not to the people who
            opened the changes.
          </p>
        </div>

        {d.waiting.length === 0 ? (
          <p className="py-4 text-center text-sm text-fg-faint">
            {d.tracked && d.totals.neverReviewed > 0
              ? 'No tracked developer’s pull request opened in this window is waiting on a first review.'
              : 'No pull request opened in this window is waiting on a first review.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <TableHeadRow>
                  <th className="py-2 pr-4 font-medium">Pull request</th>
                  <th className="py-2 pr-4 font-medium">Author</th>
                  <th className="py-2 pr-4 font-medium">Size</th>
                  <th className="py-2 font-medium">Waiting</th>
                </TableHeadRow>
              </thead>
              <tbody>
                {d.waiting.map((pr) => (
                  <TableBodyRow key={pr.ref}>
                    <td className="max-w-md py-2.5 pr-4">
                      <span className="block truncate text-fg-secondary" title={pr.title}>
                        {pr.title}
                      </span>
                      <span className="text-xs text-fg-faint">{pr.ref}</span>
                    </td>
                    <td className="py-2.5 pr-4 text-fg-muted">
                      {/* Linked by canonical id, named as every other table
                          names people; the login stays on hover. */}
                      {pr.authorDeveloper ? (
                        <Link
                          to={developerHref(pr.authorDeveloper, range)}
                          className="hover:text-fg"
                          title={pr.author ?? undefined}
                        >
                          {pr.authorDisplayName ?? pr.authorDeveloper}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-2.5 pr-4 tabular-nums text-xs">
                      <span className="text-success-fg">+{pr.additions}</span>{' '}
                      <span className="text-danger-fg">−{pr.deletions}</span>
                    </td>
                    <td className="py-2.5 tabular-nums">
                      <span
                        className={
                          pr.waitingHours >= d.thresholdHours
                            ? 'text-warning-fg'
                            : 'text-fg-muted'
                        }
                      >
                        {formatWait(pr.waitingHours)}
                      </span>
                    </td>
                  </TableBodyRow>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {d.waitingTotal > d.waiting.length && (
          <p className="text-xs text-fg-subtle">
            Showing the {d.waiting.length} longest waits of {d.waitingTotal}.
          </p>
        )}

        <MeasurementNotes d={d} />
      </Card>

      <Card className="space-y-3">
        <div>
          <h3 className="font-semibold text-fg">Review load</h3>
          <p className="text-xs text-fg-subtle">
            Alphabetical, not by volume — review is a service to the team, and
            ordering people by how much of it they did is a leaderboard from
            either end. Reviews on one’s own pull requests are not counted.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <TableHeadRow>
                <th className="py-2 pr-4 font-medium">Developer</th>
                <th className="py-2 pr-4 font-medium">PRs raised</th>
                <th className="py-2 pr-4 font-medium">Reviews given</th>
                <th className="py-2 font-medium">Oldest PR waiting</th>
              </TableHeadRow>
            </thead>
            <tbody>
              {d.reviewLoad.map((row) => (
                <TableBodyRow key={row.developer}>
                  <td className="py-2.5 pr-4">
                    <Link
                      to={developerHref(row.developer, range)}
                      className="font-medium text-fg-secondary hover:text-fg"
                    >
                      {row.displayName}
                    </Link>
                  </td>
                  <td className="py-2.5 pr-4 tabular-nums">{row.prsRaised}</td>
                  <td className="py-2.5 pr-4 tabular-nums">
                    {row.prsReviewed}
                  </td>
                  <td className="py-2.5 tabular-nums">
                    {/* A fact, not an average. A mean over two PRs describes
                        neither of them. */}
                    {row.oldestWaitingHours === null ? (
                      <span className="text-fg-faint">—</span>
                    ) : (
                      <span
                        className={
                          row.oldestWaitingHours >= d.thresholdHours
                            ? 'text-warning-fg'
                            : 'text-fg-muted'
                        }
                      >
                        {formatWait(row.oldestWaitingHours)}
                      </span>
                    )}
                  </td>
                </TableBodyRow>
              ))}
              {d.reviewLoad.length === 0 && (
                <TableBodyRow>
                  {/* Rows come from the window AND from today's queue, so the
                      empty state has to rule out both. */}
                  <td colSpan={4} className="py-4 text-center text-sm text-fg-faint">
                    Nobody opened or reviewed a pull request in this window,
                    and none is waiting.
                  </td>
                </TableBodyRow>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-fg-subtle">
          Cycle-time percentiles (time to first review, review time, merge time)
          live on{' '}
          <Link to="/efficiency" className="text-brand hover:underline">
            Efficiency
          </Link>
          , measured over merged PRs. This page counts the ones still open.
        </p>
      </Card>

      <ProvenanceNote>
        A review-capacity signal, never a measure of the people who opened the
        changes. Computed {timeAgo(d.computedAt)}.
      </ProvenanceNote>
    </div>
  );
}

/**
 * What the tiles cover, what the range left out, and what the tables list.
 *
 * Sits with the tiles it explains, not at the foot of the page. The range
 * picks PRs by when they were OPENED, so a change opened months ago and still
 * unreviewed — the most actionable row this page can carry — falls outside a
 * short range. Saying how many did, with the way to bring them in, is what
 * keeps the filter from hiding them. And the tiles count every PR while the
 * tables list tracked developers only, so that subset is stated too.
 */
function QueueScopeNote({ d }: { d: PrStatusView }) {
  return (
    <p className="text-xs text-fg-subtle">
      <span className="text-fg-secondary">Open, waiting and never-reviewed
      count pull requests opened in this window that are still open
      today</span>, with waits measured to now. Reviews given counts reviews
      submitted in the window.{' '}
      {d.openOutsideRange > 0 && (
        <>
          <span className="font-medium text-warning-fg">
            {d.openOutsideRange} more open{' '}
            {d.openOutsideRange === 1 ? 'PR was' : 'PRs were'} opened outside
            this window
          </span>{' '}
          and {d.openOutsideRange === 1 ? 'is' : 'are'} not counted — widen
          the range to see {d.openOutsideRange === 1 ? 'it' : 'them'}.{' '}
        </>
      )}
      {d.tracked ? (
        <>
          The tiles count every pull request; the tables list tracked
          developers’ only —{' '}
          <span className="text-fg-secondary">
            {d.tracked.neverReviewed} of the {d.totals.neverReviewed} never
            reviewed, {d.tracked.waitingOverThreshold} of them past{' '}
            {d.thresholdHours}h
          </span>
          .
        </>
      ) : (
        'The tiles and the tables cover the same pull requests.'
      )}
    </p>
  );
}

/** Everything the queue could not measure, and how current its reviews are. */
function MeasurementNotes({ d }: { d: PrStatusView }) {
  const unmeasured = d.excludedNoReviewData + d.excludedNoOpenedDate;
  return (
    <>
      {unmeasured > 0 && (
        <p className="rounded-md border border-border bg-subtle p-2.5 text-xs text-fg-muted">
          <span className="font-medium text-fg">{unmeasured}</span> open{' '}
          {unmeasured === 1 ? 'PR is' : 'PRs are'} excluded above
          {d.excludedNoReviewData > 0 &&
            ` — ${d.excludedNoReviewData} because ${d.excludedNoReviewData === 1 ? 'its' : 'their'} review timeline has not been collected yet. “Never asked” is not “never reviewed”, and counting them as unreviewed would report collection lag as a review failure`}
          {d.excludedNoOpenedDate > 0 &&
            `${d.excludedNoReviewData > 0 ? ';' : ' —'} ${d.excludedNoOpenedDate} because no opened date was collected, so there is no wait to measure`}
          .
        </p>
      )}
      {/* Open PRs are not re-asked for reviews once collected (api/README.md
          §12), so the queue is only as current as its oldest timeline. */}
      {d.reviewsFetchedOldestAt && (
        <p className="text-xs text-fg-subtle">
          Review timelines on these pull requests were collected between{' '}
          {timeAgo(d.reviewsFetchedOldestAt)} and now. A review submitted since
          a PR was collected may not show here yet.
        </p>
      )}
    </>
  );
}
