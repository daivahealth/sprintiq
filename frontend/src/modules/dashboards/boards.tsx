import { useEffect, useState } from 'react';
import { MultiSelect } from '../../components/multi-select';
import { Badge, Card } from '../../components/ui';
import { useScope } from '../../lib/scope';
import { formatHours, timeAgo } from '../../lib/utils';
import { ScopeBar } from './ScopeBar';
import { useProjects } from './useCatalog';
import {
  type SprintPace,
  useActiveSprintsHealth,
  useActiveSprintsRisk,
  useEfficiency,
  useForecast,
  useProductivity,
  useSprintCatalog,
  useSprintHealth,
  useSprintRisk,
  useVelocity,
} from './useInsights';
import {
  BarList,
  ErrorCard,
  LoadingCard,
  SprintPicker,
  Stat,
  WorkItemsTable,
} from './widgets';

/**
 * The COMMON dashboards (DASHBOARDS.md): metric-centric, scope-driven, role-
 * assigned — not persona pages. Every number is computed server-side from
 * Jira↔GitHub correlated facts; missing data renders as missing, never faked.
 */

function BoardHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-xl font-semibold text-slate-800">{title}</h2>
      <p className="text-sm text-slate-500">{subtitle}</p>
    </div>
  );
}

/** Shared sprint selection (auto-picks the active sprint in scope). */
function useSprintSelection() {
  const { scope } = useScope();
  const catalog = useSprintCatalog(scope.projects);
  const [sprint, setSprint] = useState<string | null>(null);
  const sprints = catalog.data?.items ?? [];

  useEffect(() => {
    if (!sprint && sprints.length > 0) {
      const active = sprints.find((s) => s.state === 'active');
      setSprint((active ?? sprints[0]).externalId);
    }
  }, [sprint, sprints]);

  return { sprints, sprint, setSprint, loading: catalog.isLoading };
}

const PACE_TONE: Record<SprintPace, 'good' | 'warn' | 'bad' | 'neutral'> = {
  'on-track': 'good',
  'at-risk': 'warn',
  behind: 'bad',
  unknown: 'neutral',
};

function PaceBadge({ pace }: { pace: SprintPace }) {
  return <Badge tone={PACE_TONE[pace]}>{pace}</Badge>;
}

/**
 * Multi-project sprint lifecycles: the default view is ONE CARD PER ACTIVE
 * SPRINT (each project runs its own cadence), ranked worst-pace-first. Pace is
 * cadence-normalized (completion% vs elapsed% of that sprint's own window).
 * Click a card — or pick any sprint incl. closed ones — for the detail.
 */
export function SprintHealthBoard() {
  const { scope, setScope } = useScope();
  const [projectSearch, setProjectSearch] = useState('');
  const projects = useProjects(projectSearch);
  const active = useActiveSprintsHealth(scope.projects);
  const { sprints, sprint, setSprint } = useSprintSelection();
  const detail = useSprintHealth(sprint);
  const d = detail.data;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <BoardHeader
        title="Sprint Health"
        subtitle="Every project runs its own sprint lifecycle — all concurrent active sprints at a glance, worst pace first. Click one to drill in."
      />

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <MultiSelect
          label="Projects"
          options={(projects.data?.items ?? []).map((p) => p.key)}
          selected={scope.projects}
          onChange={(next) => setScope({ projects: next, repos: [] })}
          onSearch={setProjectSearch}
          loading={projects.isLoading}
          emptyText="No projects found"
        />
        <SprintPicker
          sprints={sprints}
          selected={sprint}
          onChange={setSprint}
        />
      </div>

      {active.isLoading && <LoadingCard />}
      {active.isError && <ErrorCard error={active.error} />}
      {active.data && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-slate-600">
            Active sprints ({active.data.rows.length})
          </h4>
          {active.data.rows.length === 0 ? (
            <Card>
              <p className="py-4 text-center text-sm text-slate-400">
                No active sprints in scope.
              </p>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {active.data.rows.map((row) => (
                <button
                  key={row.sprint.externalId}
                  type="button"
                  onClick={() => setSprint(row.sprint.externalId)}
                  className={cnCard(sprint === row.sprint.externalId)}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate font-medium text-slate-700">
                      {row.sprint.projectKey} · {row.sprint.name}
                    </span>
                    <PaceBadge pace={row.pace} />
                  </div>
                  <PaceBar
                    completionPct={row.completionPct}
                    elapsedPct={row.elapsedPct}
                  />
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>
                      {row.completionPct === null
                        ? 'no estimated pts'
                        : `${row.completionPct}% done`}
                      {row.elapsedPct !== null &&
                        ` · ${row.elapsedPct}% elapsed`}
                    </span>
                    <span>
                      {row.daysRemaining !== null && `${row.daysRemaining}d left`}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400">
                    {row.itemsDone}/{row.itemsTotal} items ·{' '}
                    {row.codeLinkagePct === null
                      ? 'no code linkage'
                      : `${row.codeLinkagePct}% linked to code`}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {detail.isLoading && sprint && <LoadingCard />}
      {detail.isError && <ErrorCard error={detail.error} />}
      {d && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-800">
              {d.sprint.projectKey} · {d.sprint.name}
            </h3>
            <span className="space-x-2">
              <Badge tone={d.sprint.state === 'active' ? 'good' : 'neutral'}>
                {d.sprint.state}
              </Badge>
              <PaceBadge pace={d.pace} />
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat
              label="Completion"
              value={d.completionPct === null ? '—' : `${d.completionPct}%`}
              hint={`${d.completedPoints}/${d.committedPoints} pts`}
            />
            <Stat
              label="Sprint elapsed"
              value={d.elapsedPct === null ? '—' : `${d.elapsedPct}%`}
              hint={`${d.itemsDone}/${d.itemsTotal} items done`}
            />
            <Stat
              label="Code linkage"
              value={d.codeLinkagePct === null ? '—' : `${d.codeLinkagePct}%`}
              hint={`${d.itemsWithCode} items with linked PRs`}
            />
            <Stat
              label="Days remaining"
              value={d.daysRemaining ?? '—'}
              hint={
                d.unestimatedItems > 0
                  ? `${d.unestimatedItems} unestimated`
                  : undefined
              }
            />
          </div>
          <div>
            <h4 className="mb-2 text-sm font-medium text-slate-600">
              Progress by work-item type
            </h4>
            <BarList
              rows={d.byType.map((t) => ({
                label: t.type,
                value: t.done,
                secondary: `/ ${t.total}`,
              }))}
            />
          </div>
        </Card>
      )}
    </div>
  );
}

function cnCard(selected: boolean): string {
  return [
    'space-y-2 rounded-xl border bg-white p-4 text-left shadow-sm transition hover:border-brand/60',
    selected ? 'border-brand ring-2 ring-brand/20' : 'border-slate-200',
  ].join(' ');
}

/** Completion vs elapsed on one track — the cadence-normalized pace visual. */
function PaceBar({
  completionPct,
  elapsedPct,
}: {
  completionPct: number | null;
  elapsedPct: number | null;
}) {
  return (
    <div className="relative h-3 overflow-hidden rounded bg-slate-100">
      <div
        className="h-full rounded bg-brand"
        style={{ width: `${completionPct ?? 0}%` }}
      />
      {elapsedPct !== null && (
        <div
          className="absolute top-0 h-full w-0.5 bg-slate-500"
          style={{ left: `${elapsedPct}%` }}
          title={`${elapsedPct}% of sprint elapsed`}
        />
      )}
    </div>
  );
}

/**
 * Multi-project sprint lifecycles: default is ONE RISK CARD PER ACTIVE SPRINT
 * in scope, ranked most-at-risk-first; project picker filters scope; click a
 * card (or pick any sprint incl. closed) to drill into the item table.
 */
export function SprintRiskBoard() {
  const { scope, setScope } = useScope();
  const [projectSearch, setProjectSearch] = useState('');
  const projects = useProjects(projectSearch);
  const active = useActiveSprintsRisk(scope.projects);
  const { sprints, sprint, setSprint } = useSprintSelection();
  const query = useSprintRisk(sprint);
  const d = query.data;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <BoardHeader
        title="Sprint Risk"
        subtitle="Every project runs its own sprint lifecycle — risk across all concurrent active sprints, worst first. Click one to drill in."
      />

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <MultiSelect
          label="Projects"
          options={(projects.data?.items ?? []).map((p) => p.key)}
          selected={scope.projects}
          onChange={(next) => setScope({ projects: next, repos: [] })}
          onSearch={setProjectSearch}
          loading={projects.isLoading}
          emptyText="No projects found"
        />
        <SprintPicker sprints={sprints} selected={sprint} onChange={setSprint} />
      </div>

      {active.isLoading && <LoadingCard />}
      {active.isError && <ErrorCard error={active.error} />}
      {active.data && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-slate-600">
            Active sprints ({active.data.rows.length})
          </h4>
          {active.data.rows.length === 0 ? (
            <Card>
              <p className="py-4 text-center text-sm text-slate-400">
                No active sprints in scope.
              </p>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {active.data.rows.map((row) => (
                <button
                  key={row.sprint.externalId}
                  type="button"
                  onClick={() => setSprint(row.sprint.externalId)}
                  className={cnCard(sprint === row.sprint.externalId)}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate font-medium text-slate-700">
                      {row.sprint.projectKey} · {row.sprint.name}
                    </span>
                    <Badge
                      tone={
                        row.openWithoutCode.length === 0
                          ? 'good'
                          : row.atRiskPoints > 0
                            ? 'bad'
                            : 'warn'
                      }
                    >
                      {row.openWithoutCode.length === 0
                        ? 'no risk items'
                        : `${row.openWithoutCode.length} at risk`}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div>
                      <div className="text-lg font-semibold text-slate-800 tabular-nums">
                        {row.atRiskPoints}
                      </div>
                      <div className="text-slate-400">at-risk pts</div>
                    </div>
                    <div>
                      <div className="text-lg font-semibold text-slate-800 tabular-nums">
                        {row.openBugs}
                      </div>
                      <div className="text-slate-400">open bugs</div>
                    </div>
                    <div>
                      <div className="text-lg font-semibold text-slate-800 tabular-nums">
                        {row.unestimatedOpen}
                      </div>
                      <div className="text-slate-400">unestimated</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {query.isLoading && sprint && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {d && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-800">
              {d.sprint.projectKey} · {d.sprint.name}
            </h3>
            <Badge tone={d.sprint.state === 'active' ? 'good' : 'neutral'}>
              {d.sprint.state}
            </Badge>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Open items w/o code" value={d.openWithoutCode.length} />
            <Stat label="At-risk points" value={d.atRiskPoints} />
            <Stat label="Open bugs" value={d.openBugs} />
            <Stat label="Unestimated open" value={d.unestimatedOpen} />
          </div>
          <div>
            <h4 className="mb-2 text-sm font-medium text-slate-600">
              Open items with no linked GitHub activity
            </h4>
            <WorkItemsTable items={d.openWithoutCode} />
          </div>
        </Card>
      )}
    </div>
  );
}

export function VelocityBoard() {
  const { scope } = useScope();
  const query = useVelocity(scope.projects);
  const rows = query.data?.rows ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <BoardHeader
        title="Velocity"
        subtitle="Completed vs committed story points per closed sprint."
      />
      <ScopeBar />
      {query.isLoading && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {query.data && (
        <Card className="space-y-4">
          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">
              No closed sprints in scope yet — velocity appears after the first
              sprint closes.
            </p>
          ) : (
            <>
              <BarList
                rows={rows.map((r) => ({
                  label: `${r.sprint.projectKey} · ${r.sprint.name}`,
                  value: r.completedPoints,
                  secondary: `/ ${r.committedPoints} pts`,
                }))}
              />
              <p className="border-t border-slate-100 pt-3 text-xs text-slate-400">
                Bars show completed points; “/ N” is committed. Computed{' '}
                {timeAgo(query.data.computedAt)}.
              </p>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

export function ForecastBoard() {
  const { scope } = useScope();
  const query = useForecast(scope.projects);
  const rows = query.data?.rows ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <BoardHeader
        title="Forecasting"
        subtitle="Average velocity of recent closed sprints vs remaining backlog."
      />
      <ScopeBar />
      {query.isLoading && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {query.data && (
        <div className="space-y-4">
          {rows.map((f) => (
            <Card key={f.projectKey} className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-slate-800">{f.projectKey}</h3>
                <Badge tone={f.sprintsSampled > 0 ? 'good' : 'warn'}>
                  {f.sprintsSampled > 0
                    ? `${f.sprintsSampled} sprint(s) sampled`
                    : 'No velocity history'}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat
                  label="Avg velocity"
                  value={f.avgVelocityPoints ?? '—'}
                  hint="pts / sprint"
                />
                <Stat
                  label="Remaining backlog"
                  value={f.remainingPoints}
                  hint={`${f.remainingItems} items · ${f.unestimatedItems} unestimated`}
                />
                <Stat label="Sprints needed" value={f.sprintsNeeded ?? '—'} />
                <Stat
                  label="Projected finish"
                  value={
                    f.projectedDate
                      ? new Date(f.projectedDate).toLocaleDateString()
                      : '—'
                  }
                  hint={`assumes ${f.assumedSprintDays}d sprints`}
                />
              </div>
              {f.unestimatedItems > 0 && (
                <p className="text-xs text-amber-600">
                  {f.unestimatedItems} unestimated item(s) are not in the
                  projection — the real finish is later than shown.
                </p>
              )}
            </Card>
          ))}
          {rows.length === 0 && (
            <Card>
              <p className="py-4 text-center text-sm text-slate-400">
                No projects in scope.
              </p>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

export function ProductivityBoard() {
  const { scope, from } = useScope();
  const query = useProductivity(scope, from);
  const weeks = query.data?.weeks ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <BoardHeader
        title="Productivity"
        subtitle="Weekly throughput across Jira (items, points) and GitHub (PRs, LOC)."
      />
      <ScopeBar />
      {query.isLoading && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {query.data && (
        <Card className="space-y-5">
          <div>
            <h4 className="mb-2 text-sm font-medium text-slate-600">
              Items completed per week
            </h4>
            <BarList
              rows={weeks.map((w) => ({
                label: `wk ${w.weekStart}`,
                value: w.itemsCompleted,
                secondary: `${w.pointsCompleted} pts`,
              }))}
            />
          </div>
          <div>
            <h4 className="mb-2 text-sm font-medium text-slate-600">
              PRs merged per week
            </h4>
            <BarList
              color="bg-emerald-500"
              rows={weeks.map((w) => ({
                label: `wk ${w.weekStart}`,
                value: w.prsMerged,
                secondary: `${w.locChanged} LOC`,
              }))}
            />
          </div>
          <p className="border-t border-slate-100 pt-3 text-xs text-slate-400">
            Team-level throughput — not an individual ranking. Computed{' '}
            {timeAgo(query.data.computedAt)}.
          </p>
        </Card>
      )}
    </div>
  );
}

export function EfficiencyBoard() {
  const { scope, from } = useScope();
  const query = useEfficiency(scope, from);
  const d = query.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <BoardHeader
        title="Efficiency"
        subtitle="Cycle times plus bi-directional Jira↔GitHub traceability."
      />
      <ScopeBar />
      {query.isLoading && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {d && (
        <>
          <Card className="space-y-4">
            <h4 className="text-sm font-medium text-slate-600">Cycle times</h4>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat
                label="PR cycle p50"
                value={formatHours(d.prCycle.p50Hours)}
                hint={`${d.prCycle.sampleSize} merged PRs`}
              />
              <Stat label="PR cycle p85" value={formatHours(d.prCycle.p85Hours)} />
              <Stat
                label="Story cycle p50"
                value={d.storyCycle.p50Days === null ? '—' : `${d.storyCycle.p50Days}d`}
                hint={`${d.storyCycle.sampleSize} resolved items`}
              />
              <Stat
                label="Story cycle p85"
                value={d.storyCycle.p85Days === null ? '—' : `${d.storyCycle.p85Days}d`}
              />
            </div>
          </Card>
          <Card className="space-y-4">
            <h4 className="text-sm font-medium text-slate-600">
              Traceability (bi-directional)
            </h4>
            <div className="grid grid-cols-2 gap-4">
              <Stat
                label="Jira → GitHub"
                value={
                  d.traceability.storiesWithCodePct === null
                    ? '—'
                    : `${d.traceability.storiesWithCodePct}%`
                }
                hint={`${d.traceability.storiesTotal} work items with linked code`}
              />
              <Stat
                label="GitHub → Jira"
                value={
                  d.traceability.prsWithStoryPct === null
                    ? '—'
                    : `${d.traceability.prsWithStoryPct}%`
                }
                hint={`${d.traceability.prsTotal} PRs referencing work items`}
              />
            </div>
            <p className="border-t border-slate-100 pt-3 text-xs text-slate-400">
              Derived from the correlation graph (confidence-scored links;
              orphans surfaced, never guessed). Computed {timeAgo(d.computedAt)}.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
