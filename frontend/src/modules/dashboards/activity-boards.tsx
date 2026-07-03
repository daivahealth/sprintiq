import { useEffect, useState } from 'react';
import { Badge, Card } from '../../components/ui';
import { cn, timeAgo } from '../../lib/utils';
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
    <div>
      <span className="mb-1 block text-xs font-medium text-slate-500">
        Window
      </span>
      <div className="flex overflow-hidden rounded-md border border-slate-300">
        {WINDOWS.map((w) => (
          <button
            key={w.key}
            type="button"
            onClick={() => onChange(w.key)}
            className={cn(
              'px-3 py-2 text-sm',
              value === w.key
                ? 'bg-brand text-white'
                : 'bg-white text-slate-600 hover:bg-slate-50',
            )}
          >
            {w.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Most-active projects: commits + LOC across all repos mapped to each project. */
export function ProjectActivityBoard() {
  const [window, setWindow] = useState<ActivityWindow>('week');
  const query = useProjectActivity(window);
  const rows = query.data?.rows ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-800">
          Project Activity
        </h2>
        <p className="text-sm text-slate-500">
          Most-active projects by commits and changed LOC, aggregated across
          every repo mapped to the project (delivery graph).
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <WindowToggle value={window} onChange={setWindow} />
      </div>

      {query.isLoading && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {query.data && (
        <Card className="space-y-5">
          <div>
            <h4 className="mb-2 text-sm font-medium text-slate-600">
              Activity timeline (commits per day by project)
            </h4>
            <ProjectActivityChart rows={rows} windowDays={WINDOW_DAYS[window]} />
          </div>

          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                    <th className="py-2 pr-4 font-medium">Project</th>
                    <th className="py-2 pr-4 font-medium">Commits</th>
                    <th className="py-2 pr-4 font-medium">+ / −</th>
                    <th className="py-2 pr-4 font-medium">Active repos</th>
                    <th className="py-2 pr-4 font-medium">Top repo</th>
                    <th className="py-2 font-medium">Contributors</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={r.projectKey}
                      className="border-b border-slate-100 last:border-0 hover:bg-slate-50"
                    >
                      <td className="py-2.5 pr-4 font-medium text-slate-700">
                        {i === 0 && r.commits > 0 && (
                          <Badge tone="good">Top</Badge>
                        )}{' '}
                        {r.projectKey}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">{r.commits}</td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        <span className="text-emerald-600">+{r.additions}</span>{' '}
                        / <span className="text-rose-500">−{r.deletions}</span>
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        {r.activeRepos}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-600">
                        {r.topRepo ?? '—'}
                      </td>
                      <td className="py-2.5 tabular-nums">{r.contributors}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="border-t border-slate-100 pt-3 text-xs text-slate-400">
            Repos linked to no project are reported under “(unlinked repos)”.
            Computed {timeAgo(query.data.computedAt)}.
          </p>
        </Card>
      )}
    </div>
  );
}

/** GitHub-style per-developer activity: commit history, repos, LOC, projects. */
export function DeveloperActivityBoard() {
  const [search, setSearch] = useState('');
  const [developer, setDeveloper] = useState<string | null>(null);
  const [window, setWindow] = useState<ActivityWindow>('month');
  const catalog = useDeveloperCatalog(search);
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
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-800">
          Developer Activity
        </h2>
        <p className="text-sm text-slate-500">
          Commit history, repositories, lines committed, and active projects for
          one developer. Activity context — not a performance ranking.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <div>
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Developer
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter…"
            className="mb-1 w-64 rounded-md border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-brand"
          />
          <select
            value={developer ?? ''}
            onChange={(e) => setDeveloper(e.target.value)}
            className="block w-64 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand"
          >
            <option value="" disabled>
              Select a developer…
            </option>
            {developers.map((dev) => (
              <option key={dev.login} value={dev.login}>
                {dev.login}
              </option>
            ))}
          </select>
        </div>
        <WindowToggle value={window} onChange={setWindow} />
      </div>

      {query.isLoading && developer && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {d && (
        <>
          <Card className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-slate-800">{d.developer}</h3>
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
              <h4 className="mb-2 text-sm font-medium text-slate-600">
                Commits per day
              </h4>
              <CommitChart
                series={d.dailySeries}
                windowDays={WINDOW_DAYS[window]}
              />
            </div>
          </Card>

          <Card className="space-y-3">
            <h4 className="text-sm font-medium text-slate-600">
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
            <h4 className="text-sm font-medium text-slate-600">
              Recent commits
            </h4>
            <ul className="divide-y divide-slate-100">
              {d.recentCommits.map((c) => (
                <li key={`${c.repo}@${c.sha}`} className="flex items-center gap-3 py-2 text-sm">
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                    {c.sha}
                  </code>
                  <span className="w-40 shrink-0 truncate text-slate-500">
                    {c.repo}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-700">
                    {c.message}
                  </span>
                  <span className="shrink-0 tabular-nums text-xs">
                    <span className="text-emerald-600">+{c.additions}</span>{' '}
                    <span className="text-rose-500">−{c.deletions}</span>
                  </span>
                  <span className="w-20 shrink-0 text-right text-xs text-slate-400">
                    {timeAgo(c.authoredAt)}
                  </span>
                </li>
              ))}
              {d.recentCommits.length === 0 && (
                <li className="py-4 text-center text-sm text-slate-400">
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
