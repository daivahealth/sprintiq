import { useEffect, useState } from 'react';
import { Badge, Card } from '../../components/ui';
import { useScope } from '../../lib/scope';
import { formatHours, timeAgo } from '../../lib/utils';
import { ScopeBar } from './ScopeBar';
import {
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

export function SprintHealthBoard() {
  const { sprints, sprint, setSprint } = useSprintSelection();
  const query = useSprintHealth(sprint);
  const d = query.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <BoardHeader
        title="Sprint Health"
        subtitle="Committed vs completed, code linkage, and by-type progress for one sprint."
      />
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <SprintPicker sprints={sprints} selected={sprint} onChange={setSprint} />
      </div>
      {query.isLoading && sprint && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {d && (
        <>
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
              <Stat
                label="Completion"
                value={d.completionPct === null ? '—' : `${d.completionPct}%`}
                hint={`${d.completedPoints}/${d.committedPoints} pts`}
              />
              <Stat
                label="Items done"
                value={`${d.itemsDone}/${d.itemsTotal}`}
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
        </>
      )}
    </div>
  );
}

export function SprintRiskBoard() {
  const { sprints, sprint, setSprint } = useSprintSelection();
  const query = useSprintRisk(sprint);
  const d = query.data;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <BoardHeader
        title="Sprint Risk"
        subtitle="Open work without linked code, open bugs, and unestimated items."
      />
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <SprintPicker sprints={sprints} selected={sprint} onChange={setSprint} />
      </div>
      {query.isLoading && sprint && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {d && (
        <Card className="space-y-4">
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
