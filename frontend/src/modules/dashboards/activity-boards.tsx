import { useState } from 'react';
import { FreshnessNote } from './FreshnessNote';
import {
  Badge,
  Card,
  FilterBar,
  ProvenanceNote,
  TableBodyRow,
  TableHeadRow,
} from '../../components/ui';
import { timeAgo } from '../../lib/utils';
import { WINDOW_DAYS, WindowToggle, windowFrom } from './activity-window';
import { type ActivityWindow, useProjectActivity } from './useInsights';
import { ProjectActivityChart } from './ProjectActivityChart';
import { ErrorCard, LoadingCard } from './widgets';

/**
 * Most-active projects by changed LOC (then commits), across all repos mapped
 * to each project. Projects are codebases, not people, so ordering by volume
 * ranks nobody; LOC is still change volume, never productivity.
 */
export function ProjectActivityBoard() {
  const [window, setWindow] = useState<ActivityWindow>('week');
  const query = useProjectActivity(window);
  // Ordered here too, so an API that still sorts by commits shows the same table.
  const rows = [...(query.data?.rows ?? [])].sort(
    (a, b) => b.locChanged - a.locChanged || b.commits - a.commits,
  );
  const withoutLines = rows.reduce(
    (n, r) => n + (r.commitsWithoutLineChanges ?? 0),
    0,
  );
  const attribution = query.data?.attribution;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-[-0.035em] text-fg">
          Project Activity
        </h2>
        <p className="text-sm text-fg-subtle">
          Most-active projects by changed lines of code, then commits,
          aggregated across every repo mapped to the project (delivery graph).
        </p>
      </div>

      <FilterBar>
        <WindowToggle value={window} onChange={setWindow} />
        {/* These boards build their own FilterBar instead of the shared
            ScopeBar, so freshness has to be mounted explicitly — otherwise
            they render numbers with no staleness signal at all. */}
        <FreshnessNote windowFrom={windowFrom(window)} />
      </FilterBar>

      {query.isLoading && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {query.data && (
        <Card className="space-y-5">
          <div>
            <h4 className="mb-2 text-sm font-medium text-fg-muted">
              Activity timeline (changed lines of code per day by project)
            </h4>
            <ProjectActivityChart rows={rows} windowDays={WINDOW_DAYS[window]} />
          </div>

          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <TableHeadRow>
                    <th className="py-2 pr-4 font-medium">Project</th>
                    <th className="py-2 pr-4 font-medium">Changed LOC</th>
                    <th className="py-2 pr-4 font-medium">+ / −</th>
                    <th className="py-2 pr-4 font-medium">Commits</th>
                    <th className="py-2 pr-4 font-medium">Active repos</th>
                    <th className="py-2 pr-4 font-medium">Top repo</th>
                    <th className="py-2 font-medium">Contributors</th>
                    <th className="py-2 font-medium">Unattributed</th>
                  </TableHeadRow>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <TableBodyRow key={r.projectKey}>
                      <td className="py-2.5 pr-4 font-medium text-fg-secondary">
                        {i === 0 && r.commits > 0 && (
                          <Badge tone="good">Top</Badge>
                        )}{' '}
                        {r.projectKey}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums font-medium text-fg-secondary">
                        {r.locChanged.toLocaleString()}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        <span className="text-success-fg">+{r.additions}</span>{' '}
                        / <span className="text-danger-fg">−{r.deletions}</span>
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">{r.commits}</td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        {r.activeRepos}
                      </td>
                      <td className="py-2.5 pr-4 text-fg-muted">
                        {r.topRepo ?? '—'}
                      </td>
                      <td className="py-2.5 tabular-nums">{r.contributors}</td>
                      <td className="py-2.5 tabular-nums">
                        {r.unattributedCommits ? (
                          <span
                            className="text-warning-fg"
                            title="Commits counted in the totals whose author matched no developer — they cannot be counted under Contributors."
                          >
                            {r.unattributedCommits}
                          </span>
                        ) : (
                          <span className="text-fg-faint">—</span>
                        )}
                      </td>
                    </TableBodyRow>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {query.data.truncated && (
            <div className="rounded-md border border-warning-border bg-warning-bg p-3 text-sm text-warning-fg">
              This window contains more commits than a single read returns, so
              the totals above cover only its most recent portion. Narrow the
              window for accurate figures.
            </div>
          )}

          {attribution && attribution.commitsUnattributed > 0 && (
            <div className="rounded-md border border-border bg-subtle p-3 text-sm text-fg-muted">
              <span className="font-medium text-fg">
                {attribution.commitsUnattributed}
              </span>{' '}
              of {attribution.commitsInScope} commits in this window
              ({attribution.coveragePct}% attributed) come from{' '}
              {attribution.unattributedIdentities} git{' '}
              {attribution.unattributedIdentities === 1
                ? 'identity'
                : 'identities'}{' '}
              that match no known developer — usually a git email not verified
              on the author’s GitHub account. Their commits and LOC are counted
              above; they cannot be counted under Contributors.
            </div>
          )}

          <ProvenanceNote>
            Changed LOC is lines added plus lines removed — change volume, not
            productivity.
            {withoutLines > 0 && (
              <>
                {' '}
                {withoutLines} commit{withoutLines === 1 ? '' : 's'} in this
                window recorded no line changes (line stats not collected yet, or
                commits that change no lines), so line totals may be partial.
              </>
            )}{' '}
            Repos linked to no project are reported under “(unlinked repos)”.
            Computed {timeAgo(query.data.computedAt)}.
          </ProvenanceNote>
        </Card>
      )}
    </div>
  );
}
