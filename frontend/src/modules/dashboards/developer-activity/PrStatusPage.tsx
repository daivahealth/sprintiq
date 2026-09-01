import { Link } from 'react-router-dom';
import {
  Card,
  ProvenanceNote,
  TableBodyRow,
  TableHeadRow,
} from '../../../components/ui';
import { timeAgo } from '../../../lib/utils';
import { usePrStatus } from '../useInsights';
import { ErrorCard, LoadingCard, Stat } from '../widgets';
import { CurrentLensNote } from './CurrentLensNote';
import { useSectionRange } from './window';

/**
 * Engineering Activity §PR Status (DASHBOARDS.md §4.4.4).
 *
 * Owns what is actionable now: which changes are waiting, and how review load
 * is spread. It deliberately reports NO cycle-time percentiles — those are
 * Efficiency's, computed over a merged-only denominator, and restating them
 * here over a different denominator would put two numbers for one concept on
 * two screens and invite the reader to reconcile a gap that is by design.
 */

/** "4d 2h" — a wait is read in days once it passes one. */
function formatWait(hours: number): string {
  if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours - days * 24);
  return rest > 0 ? `${days}d ${rest}h` : `${days}d`;
}

export function PrStatusPage() {
  const { range } = useSectionRange();
  const query = usePrStatus(range);
  const d = query.data;

  if (query.isLoading) return <LoadingCard />;
  if (query.isError) return <ErrorCard error={query.error} />;
  if (!d) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Open PRs" value={d.totals.open} hint="all repos" />
        <Stat
          label={`Waiting > ${d.thresholdHours}h`}
          value={d.totals.waitingOverThreshold}
          hint="unreviewed past the threshold"
        />
        <Stat
          label="Never reviewed"
          value={d.totals.neverReviewed}
          hint="open, no review of any kind"
        />
        <Stat
          label="Reviews given"
          value={d.totals.reviewsGiven}
          hint={
            d.totals.botReviews > 0
              ? `${d.totals.botReviews} bot reviews excluded`
              : 'by people, this window'
          }
        />
      </div>

      <CurrentLensNote
        range={range}
        lens="The review queue (open PRs and how long they have waited)"
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
            No open pull request is waiting on a first review.
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
                      {pr.author ? (
                        <Link
                          to={`../developer?developer=${encodeURIComponent(pr.author)}`}
                          className="hover:text-fg"
                        >
                          {pr.author}
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

        {d.excludedNoReviewData > 0 && (
          <p className="rounded-md border border-border bg-subtle p-2.5 text-xs text-fg-muted">
            <span className="font-medium text-fg">{d.excludedNoReviewData}</span>{' '}
            open {d.excludedNoReviewData === 1 ? 'PR is' : 'PRs are'} excluded
            above because their review timeline has not been collected yet.
            “Never asked” is not “never reviewed”, and counting them as
            unreviewed would report collection lag as a review failure.
          </p>
        )}
      </Card>

      <Card className="space-y-3">
        <div>
          <h3 className="font-semibold text-fg">Review load</h3>
          <p className="text-xs text-fg-subtle">
            Alphabetical, not by volume — review is a service to the team, and
            ordering people by how much of it they did is a leaderboard from
            either end
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
                      to={`../developer?developer=${encodeURIComponent(row.developer)}`}
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
                  <td colSpan={4} className="py-4 text-center text-sm text-fg-faint">
                    No pull requests opened or reviewed in this window.
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
          , measured over merged PRs. This page counts every open one.
        </p>
      </Card>

      <ProvenanceNote>
        Open pull requests are not limited to the selected window — a change
        opened months ago and still unreviewed is the most actionable row here,
        and a date filter is exactly what would hide it. Reviews given and PRs
        raised do use the window. Computed {timeAgo(d.computedAt)}.
      </ProvenanceNote>
    </div>
  );
}
