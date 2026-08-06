import { useEffect, useState } from 'react';
import {
  Badge,
  Card,
  FilterBar,
  ProvenanceNote,
  SegmentedControl,
  TableBodyRow,
  TableHeadRow,
} from '../../components/ui';
import { SearchSelect } from '../../components/search-select';
import { timeAgo } from '../../lib/utils';
import {
  type ActivityWindow,
  useDeveloperActivity,
  useDeveloperCatalog,
  useProjectActivity,
} from './useInsights';
import { CommitChart } from './CommitChart';
import { ProjectActivityChart } from './ProjectActivityChart';
import { BarList, ErrorCard, LoadingCard, Stat } from './widgets';

const WINDOWS: { key: ActivityWindow; label: string }[] = [
  { key: 'day', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
];

/** Mirrors the backend ACTIVITY_WINDOWS mapping (insights.controller). */
const WINDOW_DAYS: Record<ActivityWindow, number> = {
  day: 1,
  week: 7,
  month: 30,
};

function WindowToggle({
  value,
  onChange,
}: {
  value: ActivityWindow;
  onChange: (w: ActivityWindow) => void;
}) {
  return (
    <SegmentedControl
      label="Window"
      value={value}
      onChange={onChange}
      options={WINDOWS.map((w) => ({ value: w.key, label: w.label }))}
    />
  );
}

/** Most-active projects: commits + LOC across all repos mapped to each project. */
export function ProjectActivityBoard() {
  const [window, setWindow] = useState<ActivityWindow>('week');
  const query = useProjectActivity(window);
  const rows = query.data?.rows ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-[-0.02em] text-fg">
          Project Activity
        </h2>
        <p className="text-sm text-fg-subtle">
          Most-active projects by commits and changed LOC, aggregated across
          every repo mapped to the project (delivery graph).
        </p>
      </div>

      <FilterBar>
        <WindowToggle value={window} onChange={setWindow} />
      </FilterBar>

      {query.isLoading && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {query.data && (
        <Card className="space-y-5">
          <div>
            <h4 className="mb-2 text-sm font-medium text-fg-muted">
              Activity timeline (commits per day by project)
            </h4>
            <ProjectActivityChart rows={rows} windowDays={WINDOW_DAYS[window]} />
          </div>

          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <TableHeadRow>
                    <th className="py-2 pr-4 font-medium">Project</th>
                    <th className="py-2 pr-4 font-medium">Commits</th>
                    <th className="py-2 pr-4 font-medium">+ / −</th>
                    <th className="py-2 pr-4 font-medium">Active repos</th>
                    <th className="py-2 pr-4 font-medium">Top repo</th>
                    <th className="py-2 font-medium">Contributors</th>
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
                      <td className="py-2.5 pr-4 tabular-nums">{r.commits}</td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        <span className="text-success-fg">+{r.additions}</span>{' '}
                        / <span className="text-danger-fg">−{r.deletions}</span>
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        {r.activeRepos}
                      </td>
                      <td className="py-2.5 pr-4 text-fg-muted">
                        {r.topRepo ?? '—'}
                      </td>
                      <td className="py-2.5 tabular-nums">{r.contributors}</td>
                    </TableBodyRow>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <ProvenanceNote>
            Repos linked to no project are reported under “(unlinked repos)”.
            Computed {timeAgo(query.data.computedAt)}.
          </ProvenanceNote>
        </Card>
      )}
    </div>
  );
}

/** GitHub-style per-developer activity: commit history, repos, LOC, projects. */
export function DeveloperActivityBoard() {
  const [appliedSearch, setAppliedSearch] = useState('');
  const [developer, setDeveloper] = useState<string | null>(null);
  const [window, setWindow] = useState<ActivityWindow>('month');
  const catalog = useDeveloperCatalog(appliedSearch);
  const developers = catalog.data?.items ?? [];
  const query = useDeveloperActivity(developer, window);
  const d = query.data;

  // Auto-select the first developer once the catalog arrives.
  useEffect(() => {
    if (!developer && developers.length > 0) {
      setDeveloper(developers[0].login);
    }
  }, [developer, developers]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-[-0.02em] text-fg">
          Developer Activity
        </h2>
        <p className="text-sm text-fg-subtle">
          Commit history, repositories, lines committed, and active projects for
          one developer. Activity context — not a performance ranking.
        </p>
      </div>

      <FilterBar>
        <SearchSelect
          label="Developer"
          value={developer}
          options={developers.map((dev) => dev.login)}
          onSearch={setAppliedSearch}
          onSelect={setDeveloper}
          loading={catalog.isFetching}
          placeholder="Search developers…"
        />
        <WindowToggle value={window} onChange={setWindow} />
      </FilterBar>

      {query.isLoading && developer && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {d && (
        <>
          <Card className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-fg">{d.developer}</h3>
              <span className="space-x-1">
                {d.activeProjects.map((p) => (
                  <Badge key={p} tone="good">
                    {p}
                  </Badge>
                ))}
                {d.activeProjects.length === 0 && (
                  <Badge tone="warn">No linked projects</Badge>
                )}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Commits" value={d.totals.commits} />
              <Stat
                label="Lines committed"
                value={d.totals.locChanged}
                hint={`+${d.totals.additions} / −${d.totals.deletions}`}
              />
              <Stat label="Repos" value={d.totals.activeRepos} />
              <Stat label="PRs authored" value={d.totals.prsAuthored} />
            </div>
            <div>
              <h4 className="mb-2 text-sm font-medium text-fg-muted">
                Commits per day
              </h4>
              <CommitChart
                series={d.dailySeries}
                windowDays={WINDOW_DAYS[window]}
              />
            </div>
          </Card>

          <Card className="space-y-3">
            <h4 className="text-sm font-medium text-fg-muted">
              Repositories committed to
            </h4>
            <BarList
              rows={d.byRepo.map((r) => ({
                label: r.repo,
                value: r.commits,
                secondary: `${r.locChanged} LOC`,
              }))}
            />
          </Card>

          <Card className="space-y-3">
            <h4 className="text-sm font-medium text-fg-muted">
              Recent commits
            </h4>
            <ul className="divide-y divide-border-subtle">
              {d.recentCommits.map((c) => (
                <li key={`${c.repo}@${c.sha}`} className="flex items-center gap-3 py-2 text-sm">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-fg-subtle">
                    {c.sha}
                  </code>
                  <span className="w-40 shrink-0 truncate text-fg-subtle">
                    {c.repo}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-fg-secondary">
                    {c.message}
                  </span>
                  <span className="shrink-0 tabular-nums text-xs">
                    <span className="text-success-fg">+{c.additions}</span>{' '}
                    <span className="text-danger-fg">−{c.deletions}</span>
                  </span>
                  <span
                    className="w-20 shrink-0 text-right text-xs text-fg-faint"
                    title={`Authored ${timeAgo(c.authoredAt)}`}
                  >
                    {timeAgo(c.committedAt)}
                  </span>
                </li>
              ))}
              {d.recentCommits.length === 0 && (
                <li className="py-4 text-center text-sm text-fg-faint">
                  No commits in this window.
                </li>
              )}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
