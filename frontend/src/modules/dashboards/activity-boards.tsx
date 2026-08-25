import { useEffect, useState } from 'react';
import { FreshnessNote } from './FreshnessNote';
import {
  Badge,
  Button,
  Card,
  FilterBar,
  ProvenanceNote,
  SegmentedControl,
  TableBodyRow,
  TableHeadRow,
} from '../../components/ui';
import { SearchSelect } from '../../components/search-select';
import { istWindowFloor, timeAgo } from '../../lib/utils';
import {
  type ActivityWindow,
  useDailyDeveloperActivity,
  useDeveloperActivity,
  useDeveloperCatalog,
  useProjectActivity,
} from './useInsights';
import { CommitChart } from './CommitChart';
import { ProjectActivityChart } from './ProjectActivityChart';
import { BarList, ErrorCard, LoadingCard, Stat } from './widgets';

/**
 * Ranges are named for what they measure. "Today" survives as a word because
 * it is genuinely calendar-aligned — the server floors to IST midnight, so it
 * means today, not the last 24 hours. The others don't get that licence: 30
 * calendar days ending on 25 Aug begins on 27 Jul, which is not "this month",
 * and a board whose whole purpose is trustworthy numbers shouldn't round its
 * own range in the label.
 */
const WINDOWS: { key: ActivityWindow; label: string }[] = [
  { key: 'day', label: 'Today' },
  { key: 'week', label: '7 days' },
  { key: 'month', label: '30 days' },
  { key: 'quarter', label: '90 days' },
  { key: 'year', label: '12 months' },
];

/** Mirrors the backend ACTIVITY_WINDOWS mapping (insights.controller). */
const WINDOW_DAYS: Record<ActivityWindow, number> = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 90,
  year: 365,
};

/** The next range up, for the empty state to offer. Undefined at the widest. */
function widerWindow(window: ActivityWindow): ActivityWindow | undefined {
  const i = WINDOWS.findIndex((w) => w.key === window);
  return WINDOWS[i + 1]?.key;
}

function windowLabel(window: ActivityWindow): string {
  return WINDOWS.find((w) => w.key === window)?.label ?? String(window);
}

/**
 * First instant of the selected window — the shared `istWindowFloor`, which
 * mirrors the backend's exactly.
 *
 * This board previously computed its own `now - days * 86400000`. That is the
 * rolling convention DASHBOARDS.md §"IST alignment" records as retired, and
 * the reason it matters here is `FreshnessNote`: it judges THIS board's window
 * rather than the dataset, so a start up to a day earlier than the one
 * actually queried had it vouching for — or warning about — time the board
 * never showed.
 */
function windowStart(window: ActivityWindow): Date {
  return istWindowFloor(WINDOW_DAYS[window]);
}

function windowFrom(window: ActivityWindow): string {
  return windowStart(window).toISOString();
}

/** "27 Jul" — the interval ends today, so the year is noise until it isn't. */
function shortDate(d: Date): string {
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

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
  const attribution = query.data?.attribution;

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
            Repos linked to no project are reported under “(unlinked repos)”.
            Computed {timeAgo(query.data.computedAt)}.
          </ProvenanceNote>
        </Card>
      )}
    </div>
  );
}

/** GitHub-style per-developer activity: commit history, repos, LOC, projects. */
/**
 * What an empty board says instead of nothing.
 *
 * A blank result has two causes that look identical on screen — nothing
 * happened, or nothing happened *in the range you picked* — and the board used
 * to render both as one dim sentence. That is not a cosmetic gap: a repository
 * dormant since July shows every one of its developers at zero on every window
 * the board offered, and a reader reasonably concludes those people are
 * inactive. Naming the interval and offering the next one up turns an absence
 * into a reading with a range attached.
 *
 * Styled as an inset caveat rather than centred filler because the board
 * already has that vocabulary directly above (the truncation note), and it sits
 * at `fg-subtle` rather than `fg-faint` — this is provenance, which the design
 * system keeps legible on purpose, not decoration.
 */
function EmptyWindowNote({
  window,
  measuredDays,
  onWiden,
}: {
  window: ActivityWindow;
  /** Days the server measured; falls back to the selection if it didn't say. */
  measuredDays?: number;
  onWiden: (w: ActivityWindow) => void;
}) {
  const days = measuredDays ?? WINDOW_DAYS[window];
  const end = new Date();
  const start = new Date(
    windowStart(window).getTime() +
      (WINDOW_DAYS[window] - days) * 86_400_000,
  );
  const wider = widerWindow(window);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-subtle p-2.5">
      <p className="text-xs text-fg-subtle">
        No commits{' '}
        {days === 1 ? (
          <>
            today (<span className="font-mono tabular-nums">{shortDate(end)}</span>)
          </>
        ) : (
          <>
            between{' '}
            <span className="font-mono tabular-nums">{shortDate(start)}</span>
            {' and '}
            <span className="font-mono tabular-nums">{shortDate(end)}</span>
          </>
        )}
        .{' '}
        {wider
          ? 'Work older than this range is not counted here.'
          : 'This is the widest range available.'}
      </p>
      {wider && (
        <Button variant="secondary" size="sm" onClick={() => onWiden(wider)}>
          Try {windowLabel(wider)}
        </Button>
      )}
    </div>
  );
}

/** IST day key ("2026-08-14") → "Thu, 14 Aug". */
function formatDayKey(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Team-level daily commit log: who committed each day, with counts.
 *
 * Defaults to alphabetical within each day — activity context, not a
 * leaderboard (CLAUDE.md). The count sort exists but is the reader's explicit
 * act: a deliberate deviation, requested and recorded in DASHBOARDS.md §4.1.3.
 */
function DailyActivitySection({
  window,
  onWindowChange,
}: {
  window: ActivityWindow;
  /** The empty state offers the next range up, so it needs to set it. */
  onWindowChange: (w: ActivityWindow) => void;
}) {
  const query = useDailyDeveloperActivity(window);
  const [sort, setSort] = useState<'name' | 'commits'>('name');
  const d = query.data;

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-fg">Daily activity</h3>
          <p className="text-xs text-fg-subtle">
            Everyone who committed, day by day
            {d ? (
              <>
                {' '}
                · {d.totals.commits.toLocaleString()} commits by{' '}
                {d.totals.activeDevelopers} developer
                {d.totals.activeDevelopers === 1 ? '' : 's'} in this window
              </>
            ) : null}
          </p>
        </div>
        <SegmentedControl
          label="Sort"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'name', label: 'A–Z' },
            { value: 'commits', label: 'Most commits' },
          ]}
        />
      </div>

      {query.isLoading && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}

      {d?.truncated && (
        <p className="rounded-md border border-border bg-subtle p-2.5 text-xs text-fg-muted">
          This window contains more commits than a single read returns, so
          these daily figures under-report. Narrow the window for accurate
          figures.
        </p>
      )}

      {d && d.days.length === 0 && (
        <EmptyWindowNote
          window={window}
          measuredDays={d.windowDays}
          onWiden={onWindowChange}
        />
      )}

      {d && d.days.length > 0 && (
        <div className="space-y-3">
          {d.days.map((day) => {
            const developers =
              sort === 'commits'
                ? // Explicitly chosen by the reader — the default stays A–Z.
                  [...day.developers].sort(
                    (a, b) =>
                      b.commits - a.commits ||
                      a.displayName.localeCompare(b.displayName),
                  )
                : day.developers;
            return (
              <div
                key={day.date}
                className="flex flex-col gap-1.5 border-b border-border-subtle pb-3 last:border-b-0 last:pb-0 sm:flex-row sm:items-baseline sm:gap-4"
              >
                <div className="flex shrink-0 items-baseline gap-2 sm:w-44">
                  <span className="text-sm font-medium text-fg-secondary">
                    {formatDayKey(day.date)}
                  </span>
                  <span className="text-xs tabular-nums text-fg-subtle">
                    {day.totalCommits} commit{day.totalCommits === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {developers.map((dev) => (
                    <span
                      key={dev.developer}
                      className="rounded bg-muted px-1.5 py-0.5 text-xs text-fg-secondary"
                    >
                      {dev.displayName}
                      <span className="ml-1 tabular-nums text-fg-subtle">
                        ×{dev.commits}
                      </span>
                    </span>
                  ))}
                  {day.unattributedCommits > 0 && (
                    <Badge tone="warn">
                      +{day.unattributedCommits} unattributed
                    </Badge>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function DeveloperActivityBoard() {
  const [appliedSearch, setAppliedSearch] = useState('');
  const [developer, setDeveloper] = useState<string | null>(null);
  const [window, setWindow] = useState<ActivityWindow>('month');
  const catalog = useDeveloperCatalog(appliedSearch);
  const developers = catalog.data?.items ?? [];
  const query = useDeveloperActivity(developer, window);
  const d = query.data;

  // Open on whoever committed most recently, not whoever sorts first.
  //
  // The list itself stays alphabetical — that is what you want when searching
  // for a name — but landing on the alphabetically-first developer meant
  // opening on someone with no recent work far more often than not (on a real
  // tenant, only 36 of 83 developers committed in the last week). An empty
  // board on arrival reads as the board being broken rather than as that
  // person having been busy elsewhere.
  useEffect(() => {
    if (developer || developers.length === 0) {
      return;
    }
    const mostRecent = developers.reduce((best, d) =>
      (d.lastActiveAt ?? '') > (best.lastActiveAt ?? '') ? d : best,
    );
    setDeveloper(mostRecent.login);
  }, [developer, developers]);

  const options = developers.map((dev) => ({
    value: dev.login,
    label: dev.displayName ?? dev.login,
    // Marked in the list rather than hidden: these are the people whose commits
    // GitHub attributed to no account, and silently omitting them is what made
    // their work look like nobody's in the first place. `attributed` absent
    // means the API can't distinguish, so nothing is claimed either way.
    hint: dev.attributed === false ? '· no linked account' : undefined,
  }));

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
          options={options}
          onSearch={setAppliedSearch}
          onSelect={setDeveloper}
          loading={catalog.isFetching}
          placeholder="Search developers…"
        />
        <WindowToggle value={window} onChange={setWindow} />
        {/* These boards build their own FilterBar instead of the shared
            ScopeBar, so freshness has to be mounted explicitly — otherwise
            they render numbers with no staleness signal at all. */}
        <FreshnessNote windowFrom={windowFrom(window)} />
      </FilterBar>

      <DailyActivitySection window={window} onWindowChange={setWindow} />

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
              <Stat
                label="PRs authored"
                value={d.totals.prsAuthored}
                // Delivery counts merged PRs by merge date; this board counts
                // every PR opened in the window. Stating both stops the two
                // boards reading as a contradiction about the same person.
                hint={
                  d.totals.prsMerged === undefined
                    ? undefined
                    : `${d.totals.prsMerged} merged`
                }
              />
            </div>

            {/* Whose identities these figures were gathered under. A person
                whose git email isn't verified on their GitHub account commits
                under a login-less identity; until it's matched, this page reads
                "0 commits" for someone who has been committing all month.
                Every branch is guarded: this build can be serving against an
                API that predates identity resolution, and an unguarded
                dereference here took the entire board down rather than
                degrading to the older, less informative rendering. */}
            {d.identity?.inferred && (
              <p className="rounded-md border border-border bg-subtle p-2.5 text-xs text-fg-muted">
                Includes commits authored as{' '}
                <span className="font-medium text-fg">
                  {d.identity.recoveredEmails.join(', ')}
                </span>
                , matched to this developer by name because GitHub attributed
                those commits to no account.
              </p>
            )}
            {d.totals.commits === 0 && d.identity && !d.identity.inferred && (
              <p className="rounded-md border border-border bg-subtle p-2.5 text-xs text-fg-muted">
                No commits matched{' '}
                <span className="font-medium text-fg">
                  {d.identity.logins.join(', ')}
                </span>{' '}
                in this window. If this developer has been committing, their git
                email is likely not verified on their GitHub account — check
                Project Activity’s unattributed count.
              </p>
            )}
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
            <ProvenanceNote>
              Activity context, never a ranking. Computed{' '}
              {timeAgo(d.computedAt)}.
            </ProvenanceNote>
          </Card>
        </>
      )}
    </div>
  );
}
