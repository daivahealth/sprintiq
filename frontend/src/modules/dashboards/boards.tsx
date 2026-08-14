import { useEffect, useState } from 'react';
import { FreshnessNote } from './FreshnessNote';
import { MultiSelect } from '../../components/multi-select';
import { Badge, Card, FilterBar, ProvenanceNote } from '../../components/ui';
import { useScope } from '../../lib/scope';
import { cn, formatHours, timeAgo } from '../../lib/utils';
import { ScopeBar } from './ScopeBar';
import { useProjects } from './useCatalog';
import {
  type SprintPace,
  type StaleSprint,
  useActiveSprintsHealth,
  useActiveSprintsRisk,
  useEfficiency,
  useFlowMetrics,
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
      <h2 className="text-xl font-semibold tracking-[-0.02em] text-fg">{title}</h2>
      <p className="text-sm text-fg-subtle">{subtitle}</p>
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

/**
 * Sprints Jira still calls active whose end date is long past.
 *
 * Shown rather than dropped: the sprint is real and someone needs to close it
 * in Jira, so hiding it would trade a misleading card for a silent omission.
 * Kept out of the ranked cards above because it is 100% elapsed by definition
 * and would always sort above the sprint that can still be acted on.
 */
function StaleSprintsNote({
  stale,
  graceDays,
}: {
  stale?: StaleSprint[];
  graceDays?: number;
}) {
  if (!stale || stale.length === 0) {
    return null;
  }
  return (
    <div className="mt-3 rounded-md border border-border bg-subtle p-3 text-sm text-fg-muted">
      <span className="font-medium text-fg">{stale.length}</span> sprint
      {stale.length === 1 ? ' is' : 's are'} still marked active in Jira but
      ended more than {graceDays ?? 14} days ago — excluded from the cards above
      because a finished sprint has no pace to report.{' '}
      {stale.map((s, i) => (
        <span key={s.sprint.externalId}>
          {i > 0 && ', '}
          <span className="text-fg-secondary">
            {s.sprint.projectKey} · {s.sprint.name}
          </span>{' '}
          ({s.daysPastEnd}d past end)
        </span>
      ))}
      . Closing {stale.length === 1 ? 'it' : 'them'} in Jira clears this.
    </div>
  );
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

      <FilterBar>
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
        {/* These boards build their own FilterBar instead of the shared
            ScopeBar, so freshness has to be mounted explicitly — otherwise
            they render numbers with no staleness signal at all. */}
        <FreshnessNote />
      </FilterBar>

      {active.isLoading && <LoadingCard />}
      {active.isError && <ErrorCard error={active.error} />}
      {active.data && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-fg-muted">
            Active sprints ({active.data.rows.length})
          </h4>
          {active.data.rows.length === 0 ? (
            <Card>
              <p className="py-4 text-center text-sm text-fg-faint">
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
                    <span className="truncate font-medium text-fg-secondary">
                      {row.sprint.projectKey} · {row.sprint.name}
                    </span>
                    <PaceBadge pace={row.pace} />
                  </div>
                  <PaceBar
                    completionPct={row.completionPct}
                    elapsedPct={row.elapsedPct}
                  />
                  <div className="flex justify-between text-xs text-fg-subtle">
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
                  <div className="text-xs text-fg-faint">
                    {row.itemsDone}/{row.itemsTotal} items ·{' '}
                    {row.codeLinkagePct === null
                      ? 'no code linkage'
                      : `${row.codeLinkagePct}% linked to code`}
                  </div>
                </button>
              ))}
            </div>
          )}
          <StaleSprintsNote
            stale={active.data.stale}
            graceDays={active.data.staleGraceDays}
          />
          <ProvenanceNote>
            Computed {timeAgo(active.data.computedAt)}.
          </ProvenanceNote>
        </div>
      )}

      {detail.isLoading && sprint && <LoadingCard />}
      {detail.isError && <ErrorCard error={detail.error} />}
      {d && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-fg">
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
            <h4 className="mb-2 text-sm font-medium text-fg-muted">
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
  return cn(
    'space-y-2 rounded-xl border bg-surface p-4 text-left shadow-sm transition hover:border-brand/60',
    selected ? 'border-brand ring-2 ring-brand/20' : 'border-border',
  );
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
    <div className="relative h-3 overflow-hidden rounded bg-muted">
      <div
        className="h-full rounded bg-brand"
        style={{ width: `${completionPct ?? 0}%` }}
      />
      {elapsedPct !== null && (
        <div
          className="absolute top-0 h-full w-0.5 bg-fg-subtle"
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

      <FilterBar>
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
        {/* These boards build their own FilterBar instead of the shared
            ScopeBar, so freshness has to be mounted explicitly — otherwise
            they render numbers with no staleness signal at all. */}
        <FreshnessNote />
      </FilterBar>

      {active.isLoading && <LoadingCard />}
      {active.isError && <ErrorCard error={active.error} />}
      {active.data && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-fg-muted">
            Active sprints ({active.data.rows.length})
          </h4>
          {active.data.rows.length === 0 ? (
            <Card>
              <p className="py-4 text-center text-sm text-fg-faint">
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
                    <span className="truncate font-medium text-fg-secondary">
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
                      <div className="text-lg font-semibold text-fg tabular-nums">
                        {row.atRiskPoints}
                      </div>
                      <div className="text-fg-faint">at-risk pts</div>
                    </div>
                    <div>
                      <div className="text-lg font-semibold text-fg tabular-nums">
                        {row.openBugs}
                      </div>
                      <div className="text-fg-faint">open bugs</div>
                    </div>
                    <div>
                      <div className="text-lg font-semibold text-fg tabular-nums">
                        {row.unestimatedOpen}
                      </div>
                      <div className="text-fg-faint">unestimated</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          <StaleSprintsNote
            stale={active.data.stale}
            graceDays={active.data.staleGraceDays}
          />
          <ProvenanceNote>
            Computed {timeAgo(active.data.computedAt)}.
          </ProvenanceNote>
        </div>
      )}

      {query.isLoading && sprint && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {d && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-fg">
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
            <h4 className="mb-2 text-sm font-medium text-fg-muted">
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
    <div className="mx-auto max-w-6xl space-y-6">
      <BoardHeader
        title="Velocity"
        subtitle="Completed vs committed story points per closed sprint."
      />
      {/* Velocity is Jira-only — it sends projects and nothing else, so the
          repo/time/group-by axes would be controls that silently do nothing. */}
      <ScopeBar showRepos={false} showTime={false} showGroupBy={false} />
      {query.isLoading && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {query.data && (
        <Card className="space-y-4">
          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-fg-faint">
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
              <ProvenanceNote>
                Bars show completed points; “/ N” is committed. Computed{' '}
                {timeAgo(query.data.computedAt)}.
              </ProvenanceNote>
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
    <div className="mx-auto max-w-6xl space-y-6">
      <BoardHeader
        title="Forecasting"
        subtitle="Average velocity of recent closed sprints vs remaining backlog."
      />
      {/* Forecasting is Jira-only — it sends projects and nothing else, so the
          repo/time/group-by axes would be controls that silently do nothing. */}
      <ScopeBar showRepos={false} showTime={false} showGroupBy={false} />
      {query.isLoading && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {query.data && (
        <div className="space-y-4">
          {rows.map((f) => (
            <Card key={f.projectKey} className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-fg">{f.projectKey}</h3>
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
                <p className="text-xs text-warning-fg">
                  {f.unestimatedItems} unestimated item(s) are not in the
                  projection — the real finish is later than shown.
                </p>
              )}
            </Card>
          ))}
          {rows.length === 0 && (
            <Card>
              <p className="py-4 text-center text-sm text-fg-faint">
                No projects in scope.
              </p>
            </Card>
          )}
          <ProvenanceNote>
            Computed {timeAgo(query.data.computedAt)}.
          </ProvenanceNote>
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
    <div className="mx-auto max-w-6xl space-y-6">
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
            <h4 className="mb-2 text-sm font-medium text-fg-muted">
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
            <h4 className="mb-2 text-sm font-medium text-fg-muted">
              PRs merged per week
            </h4>
            <BarList
              color="bg-success"
              rows={weeks.map((w) => ({
                label: `wk ${w.weekStart}`,
                value: w.prsMerged,
                secondary: `${w.locChanged} LOC`,
              }))}
            />
          </div>
          <ProvenanceNote>
            Team-level throughput — not an individual ranking. Computed{' '}
            {timeAgo(query.data.computedAt)}.
          </ProvenanceNote>
        </Card>
      )}
    </div>
  );
}

const days = (v: number | null) => (v === null ? '—' : `${v}d`);

/**
 * Flow board — cycle time, WIP and ageing, all reconstructed from the
 * status-transition timeline rather than an item's current status.
 *
 * Coverage is shown alongside the numbers, not buried: these metrics can only
 * be computed for items that actually have a transition history, so a headline
 * p50 built on a fraction of the scope would otherwise read as authoritative.
 */
export function FlowBoard() {
  const { scope } = useScope();
  const query = useFlowMetrics(scope.projects);
  const d = query.data;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <BoardHeader
        title="Flow"
        subtitle="Cycle time, work in progress and ageing, from the status-transition timeline."
      />
      {/* Flow is Jira-only — it sends projects and nothing else, so the
          repo/time/group-by axes would be controls that silently do nothing. */}
      <ScopeBar showRepos={false} showTime={false} showGroupBy={false} />
      {query.isLoading && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {d && (
        <>
          <Card className="space-y-4">
            <h4 className="text-sm font-medium text-fg-muted">
              Cycle time — start of work to first done
            </h4>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat
                label="Cycle p50"
                value={days(d.cycleTime.p50Days)}
                hint={`${d.cycleTime.sampleSize} completed items`}
              />
              <Stat label="Cycle p85" value={days(d.cycleTime.p85Days)} />
              <Stat
                label="In progress"
                value={d.wip.count}
                hint="items started, not yet done"
              />
              <Stat
                label="Oldest in progress"
                value={days(d.wip.oldestDays)}
              />
            </div>
            <ProvenanceNote>
              Measured between the first transition into an in-progress status
              and the first into a done status — not resolved−created, which
              would count backlog waiting as work.
              {d.cycleTime.excludedInstant > 0 && (
                <>
                  {' '}
                  {d.cycleTime.excludedInstant} completions finished within{' '}
                  {d.cycleTime.instantThresholdSeconds}s of starting and are
                  excluded: that's an item being clicked through several
                  workflow states in one action, not work taking no time.
                  Counting them would pull p50 to zero.
                </>
              )}
            </ProvenanceNote>
          </Card>

          <Card className="space-y-4">
            <h4 className="text-sm font-medium text-fg-muted">
              Work-in-progress age
            </h4>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat label="WIP age p50" value={days(d.wip.p50Days)} />
              <Stat label="WIP age p85" value={days(d.wip.p85Days)} />
              <Stat
                label={`Ageing (> ${d.aging.thresholdDays}d in status)`}
                value={d.aging.count}
              />
            </div>
          </Card>

          <Card className="space-y-3">
            <h4 className="text-sm font-medium text-fg-muted">
              Ageing items — longest in their current status
            </h4>
            {d.aging.items.length === 0 ? (
              <p className="text-sm text-fg-subtle">
                Nothing has been sitting in one status longer than{' '}
                {d.aging.thresholdDays} days.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-fg-subtle">
                      <th className="py-2 pr-4 font-medium">Item</th>
                      <th className="py-2 pr-4 font-medium">Project</th>
                      <th className="py-2 pr-4 font-medium">Status</th>
                      <th className="py-2 pr-4 font-medium">Days in status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.aging.items.map((i) => (
                      <tr
                        key={i.externalKey}
                        className="border-t border-border-subtle"
                      >
                        <td className="py-2 pr-4 font-medium text-fg-secondary">
                          {i.externalKey}
                        </td>
                        <td className="py-2 pr-4 text-fg-muted">
                          {i.projectKey}
                        </td>
                        <td className="py-2 pr-4 text-fg-muted">{i.status}</td>
                        <td className="py-2 pr-4 tabular-nums text-fg-muted">
                          {i.daysInStatus}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-medium text-fg-muted">
                Metric coverage
              </h4>
              <Badge
                tone={
                  (d.coverage.coveragePct ?? 0) >= 80
                    ? 'good'
                    : (d.coverage.coveragePct ?? 0) >= 40
                      ? 'warn'
                      : 'bad'
                }
              >
                {d.coverage.coveragePct === null
                  ? 'no data'
                  : `${d.coverage.coveragePct}% of items`}
              </Badge>
            </div>
            <ProvenanceNote className="border-t-0 pt-0">
              {d.coverage.itemsWithHistory} of {d.coverage.itemsInScope} items in
              scope have a transition history. The rest are excluded rather than
              counted as zero — items collected before transition history was
              available, or whose statuses aren't in the site catalog, cannot be
              measured. Computed {timeAgo(d.computedAt)}.
            </ProvenanceNote>
          </Card>
        </>
      )}
    </div>
  );
}

export function EfficiencyBoard() {
  const { scope, from } = useScope();
  const query = useEfficiency(scope, from);
  const d = query.data;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
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
            <h4 className="text-sm font-medium text-fg-muted">Cycle times</h4>
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
            <ProvenanceNote>
              Story cycle here is lead time — Jira resolved date minus Jira
              created date — so it includes backlog waiting. For time spent
              actually being worked, see cycle time on the Flow board.
              {d.storyCycle.excludedNoCreatedAt > 0 && (
                <>
                  {' '}
                  {d.storyCycle.excludedNoCreatedAt} resolved items carry no
                  Jira creation date and are excluded: they were collected
                  before that field was requested and haven't changed since, so
                  the sync hasn't re-walked them. They rejoin the metric on
                  their next update, or immediately after a Jira re-backfill.
                </>
              )}
            </ProvenanceNote>
          </Card>
          <Card className="space-y-4">
            <h4 className="text-sm font-medium text-fg-muted">
              Review quality
            </h4>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat
                label="Reviewed before merge"
                value={
                  d.review.mergedWithReviewPct === null
                    ? '—'
                    : `${d.review.mergedWithReviewPct}%`
                }
                hint={`${d.review.mergedTotal} merged PRs`}
              />
              <Stat
                label="Time to first review p50"
                value={formatHours(d.review.timeToFirstReview.p50Hours)}
                hint={`p85 ${formatHours(d.review.timeToFirstReview.p85Hours)}`}
              />
              <Stat
                label="Approval → merge p50"
                value={formatHours(d.review.mergeTime.p50Hours)}
              />
              <Stat
                label="Self-merged"
                value={
                  d.review.selfMergedPct === null
                    ? '—'
                    : `${d.review.selfMergedPct}%`
                }
                hint={`${d.review.selfMergedCount} of ${d.review.selfMergeSampleSize} with a known merger`}
              />
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat
                label="Active reviewers"
                value={String(d.review.reviewerCount)}
                hint="humans only"
              />
              <Stat
                label="Busiest reviewer share"
                value={
                  d.review.topReviewerSharePct === null
                    ? '—'
                    : `${d.review.topReviewerSharePct}%`
                }
                hint="concentration, not a ranking"
              />
              <Stat
                label="Comments per PR p50"
                value={
                  d.review.reviewDepth.p50Comments === null
                    ? '—'
                    : String(d.review.reviewDepth.p50Comments)
                }
                hint={`${d.review.reviewDepth.sampleSize} PRs counted`}
              />
              <Stat
                label="Rubber-stamped"
                value={
                  d.review.rubberStamp.pct === null
                    ? '—'
                    : `${d.review.rubberStamp.pct}%`
                }
                hint={`${d.review.rubberStamp.count} of ${d.review.rubberStamp.sampleSize} PRs over ${d.review.rubberStamp.sizeThreshold} lines`}
              />
            </div>
            <ProvenanceNote>
              Merged PRs only — an open PR hasn't finished waiting for review,
              so counting it would improve coverage purely because work is
              still in flight. Self-merge counts only PRs the author merged
              with no approval from anyone else. Rubber-stamped means a large
              PR approved without a single <em>inline</em> comment — review
              discussion held in the PR conversation instead of on the diff
              is not counted, so read a high rate as "worth a look", not as
              proof nobody read the code.
              {d.review.botReviews > 0 && (
                <>
                  {' '}
                  {d.review.botReviews} automated reviews are excluded from
                  every figure here — a bot approving in seconds otherwise
                  flatters coverage and drags review latency toward zero while
                  no human has looked at the change.
                  {d.review.botOnlyReviewedPrs > 0 && (
                    <>
                      {' '}
                      {d.review.botOnlyReviewedPrs} merged PRs were reviewed
                      <em> only</em> by a bot and count as unreviewed.
                    </>
                  )}
                </>
              )}
              {d.review.excludedNoReviewData > 0 && (
                <>
                  {' '}
                  {d.review.excludedNoReviewData} merged PRs are excluded
                  because their reviews haven't been collected yet — a PR with
                  no review record is indistinguishable from a genuinely
                  unreviewed one, and counting them together would report an
                  alarming self-merge rate that is really just incomplete
                  collection.
                </>
              )}
            </ProvenanceNote>
          </Card>
          <Card className="space-y-4">
            <h4 className="text-sm font-medium text-fg-muted">
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
            <ProvenanceNote>
              Derived from the correlation graph (confidence-scored links;
              orphans surfaced, never guessed). Computed {timeAgo(d.computedAt)}.
            </ProvenanceNote>
          </Card>
        </>
      )}
    </div>
  );
}
