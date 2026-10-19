import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Card,
  ProvenanceNote,
  SegmentedControl,
  TableBodyRow,
  TableHeadRow,
} from '../../../components/ui';
import { useAuthStore } from '../../../lib/stores/auth-store';
import { timeAgo } from '../../../lib/utils';
import {
  DEVELOPER_ROLES,
  DEVELOPER_ROLE_LABEL,
  UNCLASSIFIED_LABEL,
  type DeveloperRoleValue,
} from '../developer-role';
import { CommitChart } from '../CommitChart';
import { MonthlyTrendChart, type TrendMetric } from '../MonthlyTrendChart';
import {
  useDeveloperOverview,
  useMonthlyTrend,
  useSetDeveloperRole,
  type ActiveDeveloper,
  type ActivityDay,
} from '../useInsights';
import { ErrorCard, LoadingCard, Stat } from '../widgets';
import { CurrentLensNote } from './CurrentLensNote';
import { hasDailyLoc, timelineMetric } from './timeline-metric';
import {
  EmptyWindowNote,
  formatDayKey,
  rangeDays,
  rangeEndKey,
  rangeParams,
  useSectionRange,
  type ActivityRange,
} from './window';

/**
 * A link to one person's page that carries the window with it.
 *
 * The range lives in the URL, so a bare `?developer=` drops it and `parseRange`
 * falls back to the default — landing the reader on real numbers for a range
 * they did not choose. That is the one failure this section is built to
 * prevent, so every link out of it goes through here.
 */
function developerHref(developer: string, range: ActivityRange): string {
  const params = rangeParams(range);
  params.set('developer', developer);
  return `../developer?${params.toString()}`;
}

/**
 * Engineering Activity §Overview — team-shaped (DASHBOARDS.md §4.4.1).
 *
 * The team total, the shape of the window, how far the numbers can be trusted
 * — and, since 2026-09-02, who was working in it.
 *
 * That roster was deliberately absent before: an earlier design rendered the
 * *Watchlist's* roster here too, which made two screens out of one dataset.
 * This one is a different question and stays on the near side of that line.
 * The Watchlist asks **who to go ask about** — recency buckets, assignment
 * gaps, people you may need to check on. This asks **who was working**, and is
 * simply the names behind the "Developers with a signal" tile it sits above.
 * Same window, same set, one is the count and the other the list.
 *
 * It is not a ranking. Alphabetical by default, with "Most commits" as the
 * reader's explicit act — the identical treatment the day drill-down gets, and
 * for the identical reason (DASHBOARDS.md §4.1.3).
 */
export function OverviewPage() {
  const { range, setRange } = useSectionRange();
  const query = useDeveloperOverview(range);
  const d = query.data;

  if (query.isLoading) return <LoadingCard />;
  if (query.isError) return <ErrorCard error={query.error} />;
  if (!d) return null;

  const { totals, attribution, assigneeCoverage } = d;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Commits"
          value={totals.commits.toLocaleString()}
          hint="all repos, this window"
        />
        <Stat
          label="Developers with a signal"
          value={`${totals.developersWithSignal} / ${totals.developersKnown}`}
          hint="commit, PR or review"
        />
        <Stat
          label="PRs opened"
          value={totals.prsOpened}
          hint={`${totals.prsMerged} merged`}
        />
        {/* The planning gap, and the one tile that must never render a null as
            a zero: "0 people committing off-plan" and "we could not tell" are
            opposite findings. */}
        <Stat
          label="Committing, nothing assigned"
          value={
            totals.committingWithoutAssignedWork === null
              ? '—'
              : totals.committingWithoutAssignedWork
          }
          hint={
            totals.committingWithoutAssignedWork === null
              ? 'no Jira assignees matched yet'
              : 'see Watchlist'
          }
        />
      </div>

      <CurrentLensNote
        range={range}
        lens="The Jira assignment behind “Committing, nothing assigned”"
      />

      {/* Below the totals, not above them: the tiles say how much happened in
          this window, and the roster then says who that was. Reading the names
          first invites totting them up into the total yourself — which is both
          wrong (unattributed commits are in the total and on nobody's row) and
          the arithmetic a ranking is made of. */}
      <ActiveDevelopers developers={d.activeDevelopers} range={range} />

      <CommitTimeline
        days={d.days}
        range={range}
        emptyState={
          <EmptyWindowNote
            range={range}
            measuredDays={d.windowDays}
            onChange={setRange}
          />
        }
      />

      <MonthlyTrend />

      <Card className="space-y-3">
        <h3 className="text-sm font-medium text-fg-muted">Data health</h3>

        {d.truncated && (
          <p className="rounded-md border border-warning-border bg-warning-bg p-3 text-sm text-warning-fg">
            This window contains more commits than a single read returns, so the
            figures above cover only its most recent portion. Narrow the window
            for accurate numbers.
          </p>
        )}

        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-border bg-subtle p-3">
            <dt className="text-xs font-medium text-fg-secondary">
              Commit attribution
            </dt>
            <dd className="mt-1 text-sm text-fg-muted">
              {attribution.coveragePct === null ? (
                'No commits in this window to attribute.'
              ) : (
                <>
                  <span className="font-medium text-fg">
                    {attribution.coveragePct}%
                  </span>{' '}
                  of {attribution.commitsInScope.toLocaleString()} commits match
                  a known developer.{' '}
                  {attribution.commitsUnattributed > 0 && (
                    <>
                      The other{' '}
                      {attribution.commitsUnattributed.toLocaleString()} come
                      from {attribution.unattributedIdentities} git{' '}
                      {attribution.unattributedIdentities === 1
                        ? 'identity'
                        : 'identities'}{' '}
                      matching nobody — usually a git email not verified on the
                      author’s GitHub account. Counted in the totals; not
                      countable per person.
                    </>
                  )}
                </>
              )}
            </dd>
          </div>

          <div className="rounded-md border border-border bg-subtle p-3">
            <dt className="text-xs font-medium text-fg-secondary">
              Jira assignee matching
            </dt>
            <dd className="mt-1 text-sm text-fg-muted">
              {assigneeCoverage.developersInWindow === 0 ? (
                'Nobody committed in this window, so there is no bridge coverage to report.'
              ) : (
                <>
                  <span className="font-medium text-fg">
                    {assigneeCoverage.developersLinked}
                  </span>{' '}
                  of {assigneeCoverage.developersInWindow} developers who
                  committed are linked to a Jira account (
                  {assigneeCoverage.coveragePct}%).{' '}
                  {assigneeCoverage.unlinkedDevelopers.length > 0 && (
                    <>
                      Assigned work is invisible for{' '}
                      <span className="text-fg-secondary">
                        {assigneeCoverage.unlinkedDevelopers
                          .slice(0, 4)
                          .join(', ')}
                        {assigneeCoverage.unlinkedDevelopers.length > 4 &&
                          ` +${assigneeCoverage.unlinkedDevelopers.length - 4} more`}
                      </span>
                      .
                    </>
                  )}
                </>
              )}
            </dd>
          </div>
        </dl>

        <ProvenanceNote>
          Activity context, never a ranking. Computed {timeAgo(d.computedAt)}.
        </ProvenanceNote>
      </Card>
    </div>
  );
}

/**
 * Who was working in this window, and what they did.
 *
 * The names behind the "Developers with a signal" tile — the union of commit
 * authors and PR authors, which is exactly what that tile counts. Every row
 * opens that person's page with the window carried across.
 *
 * Sorting by commits is available and is never the default: the API hands this
 * over alphabetically and the toggle is the reader's explicit act, never
 * persisted (DASHBOARDS.md §4.1.3, CLAUDE.md's no-ranking rule). There are no
 * positions, medals or totals — a row is what one person did, not where they
 * placed.
 */
/**
 * One developer's DEV/QA/OTH classification: a badge for everyone, a control
 * for admins.
 *
 * SprintIQ cannot observe this — a QA engineer committing test automation and a
 * backend developer are indistinguishable in the delivery graph — so it is a
 * human statement, editable where it is read rather than on a page you have to
 * go and find.
 *
 * The gate is presentational only. The server enforces the admin role on the
 * write; hiding the control is a courtesy so non-admins are not offered an
 * action that would 403, never the thing standing between a non-admin and the
 * data.
 */
function RoleCell({ dev }: { dev: ActiveDeveloper }) {
  const user = useAuthStore((s) => s.user);
  const canEdit = user?.roles.includes('admin') ?? false;
  const setRole = useSetDeveloperRole();

  if (!canEdit) {
    return dev.role ? (
      <Badge tone="neutral">{dev.role}</Badge>
    ) : (
      <span className="text-fg-faint">{UNCLASSIFIED_LABEL}</span>
    );
  }

  return (
    <select
      value={dev.role ?? ''}
      disabled={setRole.isPending}
      onChange={(e) =>
        setRole.mutate({
          developer: dev.developer,
          // The empty option clears the classification rather than writing
          // OTH: "nobody has decided" and "somebody decided none of these"
          // are different statements and the boards render them differently.
          role: e.target.value === '' ? null : (e.target.value as DeveloperRoleValue),
        })
      }
      aria-label={`Role for ${dev.displayName}`}
      className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-fg outline-none focus:border-brand disabled:opacity-50"
    >
      <option value="">{UNCLASSIFIED_LABEL}</option>
      {DEVELOPER_ROLES.map((role) => (
        <option key={role} value={role}>
          {role} · {DEVELOPER_ROLE_LABEL[role]}
        </option>
      ))}
    </select>
  );
}

function ActiveDevelopers({
  developers,
  range,
}: {
  developers: ActiveDeveloper[];
  range: ActivityRange;
}) {
  const [sort, setSort] = useState<'name' | 'commits'>('name');

  // Nothing to show is the empty-window case, which CommitTimeline already
  // explains properly below. A second empty card would say it twice.
  if (developers.length === 0) {
    return null;
  }

  const rows =
    sort === 'commits'
      ? [...developers].sort(
          (a, b) =>
            b.commits - a.commits || a.displayName.localeCompare(b.displayName),
        )
      : developers;

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-fg">Active developers</h3>
          <p className="text-xs text-fg-subtle">
            {developers.length} with a commit or PR in this window — select one
            for their profile
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

      <div className="max-h-96 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface">
            <TableHeadRow>
              <th className="py-2 pr-4">Developer</th>
              <th className="py-2 pr-4">Role</th>
              <th className="py-2 pr-4">Commits</th>
              <th className="py-2 pr-4">Changed LOC</th>
              <th className="py-2 pr-4">PRs opened</th>
              <th className="py-2">PRs merged</th>
            </TableHeadRow>
          </thead>
          <tbody>
            {rows.map((dev) => (
              <TableBodyRow key={dev.developer}>
                <td className="py-2.5 pr-4">
                  <Link
                    to={developerHref(dev.developer, range)}
                    className="font-medium text-fg-secondary hover:text-brand-muted"
                  >
                    {dev.displayName}
                  </Link>
                </td>
                <td className="py-2.5 pr-4">
                  <RoleCell dev={dev} />
                </td>
                <td className="py-2.5 pr-4 tabular-nums text-fg-muted">
                  {dev.commits}
                </td>
                {/* An API that predates this column sends nothing, and nothing
                    is not zero: "changed no lines" and "we cannot tell" are
                    different claims, and only one of them is safe to print
                    beside a person's name. */}
                <td className="py-2.5 pr-4 tabular-nums text-fg-muted">
                  {dev.locChanged === undefined ? (
                    <span className="text-fg-faint">—</span>
                  ) : (
                    <>
                      {dev.locChanged.toLocaleString()}
                      {dev.additions !== undefined &&
                        dev.deletions !== undefined && (
                          <span className="ml-2 text-xs text-fg-subtle">
                            <span className="text-success-fg">
                              +{dev.additions.toLocaleString()}
                            </span>{' '}
                            <span className="text-danger-fg">
                              −{dev.deletions.toLocaleString()}
                            </span>
                          </span>
                        )}
                    </>
                  )}
                </td>
                <td className="py-2.5 pr-4 tabular-nums text-fg-muted">
                  {dev.prsOpened}
                </td>
                <td className="py-2.5 tabular-nums text-fg-muted">
                  {dev.prsMerged}
                </td>
              </TableBodyRow>
            ))}
          </tbody>
        </table>
      </div>

      <ProvenanceNote>
        Activity context, never a ranking. Changed LOC is volume, not
        productivity — a large number is a large diff, nothing more. Commits
        attributed to a known developer only — see data health below for what
        that leaves out.
      </ProvenanceNote>
    </Card>
  );
}

/**
 * The last year in months, commits or changed LOC.
 *
 * Everything else on this page answers "what happened in the window you
 * picked". This one answers "what has the year looked like", and its 12 months
 * are fixed — a trend that resized with the selector could not be compared
 * against itself between two visits. That difference is the thing most likely
 * to be misread here, so the subtitle states it rather than relying on the
 * heading, and the widget sits below the windowed ones instead of among them.
 *
 * Team totals only, with no per-developer breakdown: a monthly LOC line per
 * person is the vanity ranking CLAUDE.md rules out, and LOC is never a
 * productivity score.
 */
function MonthlyTrend() {
  // Changed LOC leads (team totals only — see above); commits stay one click away.
  const [metric, setMetric] = useState<TrendMetric>('loc');
  const query = useMonthlyTrend();

  if (query.isLoading) return <LoadingCard />;
  if (query.isError) return <ErrorCard error={query.error} />;
  if (!query.data) return null;

  const { months, collectedBackTo } = query.data;

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-fg">Last 12 months</h3>
          <p className="text-xs text-fg-subtle">
            One point per calendar month (IST) — a fixed year, not the window
            selected above
          </p>
        </div>
        <SegmentedControl
          label="Metric"
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'loc', label: 'Lines of code' },
            { value: 'commits', label: 'Commits' },
          ]}
        />
      </div>

      <MonthlyTrendChart months={months} metric={metric} />

      <ProvenanceNote>
        {/* The last point is the running month, which on the 3rd is three days
            of data at the same width as thirty. Drawn solid it read as a
            collapse in delivery; it is dashed and hollow, and said here too. */}
        <>
          The final point is <span className="text-fg-secondary">this month
          so far</span> — dashed and hollow because it is still filling, not a
          fall.{' '}
        </>
        {months.some((m) => !m.collected) ? (
          <>
            Shaded months predate collection — the line breaks rather than
            plotting them as zero, which would assert nobody committed.
            Collected back to {formatMonthBoundary(collectedBackTo)}.{' '}
          </>
        ) : collectedBackTo === null ? (
          <>
            How far back collection reaches is not yet established, so the
            earliest months may be incomplete.{' '}
          </>
        ) : null}
        Team totals, never a ranking. Changed LOC is volume, not productivity.
      </ProvenanceNote>
    </Card>
  );
}

/** The collection floor as a month and year, for the trend's caption. */
function formatMonthBoundary(iso: string | null): string {
  if (!iso) return 'an unknown point';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Team changed LOC per day by default, with a Lines of code / Commits toggle
 * like the 12-month trend's (commits only, and no toggle, on an API that
 * predates the per-day LOC fields). Drawn as a line since 2026-10-19 (the
 * shared `CommitChart`, as on the Developer page); clicking a day opens that
 * day's contributors.
 *
 * The line is TEAM totals. The drill-down still lists people by commits only
 * and alphabetically: per-person LOC in a day list would turn line counts into
 * a per-person measure, which this board does not do (CLAUDE.md).
 *
 * This one widget replaces two. The board this section replaced rendered a
 * commit chart AND a separate text log of who committed on each day — the same
 * dataset drawn twice, the second one scrolling for pages. Drill-down keeps
 * both readings without the duplication: the shape of the window at a glance,
 * the names when you ask for a day.
 *
 * The sort toggle is preserved verbatim from §4.1.3: alphabetical by default
 * per the no-ranking rule, with "Most commits" as a recorded, owner-requested
 * deviation that is only ever the reader's explicit act and is never persisted.
 */
function CommitTimeline({
  days,
  range,
  emptyState,
}: {
  days: ActivityDay[];
  range: ActivityRange;
  emptyState: React.ReactNode;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [sort, setSort] = useState<'name' | 'commits'>('name');
  // Changed LOC leads, as on the 12-month trend; commits stay one click away.
  // Like the sort, never persisted.
  const [requested, setRequested] = useState<TrendMetric>('loc');
  const locAvailable = hasDailyLoc(days);
  const metric = timelineMetric(days, requested);
  const byLoc = metric === 'loc';
  const withoutLines = byLoc
    ? days.reduce((n, d) => n + (d.commitsWithoutLineChanges ?? 0), 0)
    : 0;
  const header = (
    <Header
      sort={sort}
      setSort={setSort}
      metric={metric}
      setMetric={locAvailable ? setRequested : undefined}
    />
  );

  if (days.length === 0) {
    return (
      <Card className="space-y-4">
        {header}
        {emptyState}
      </Card>
    );
  }

  const openDay = days.find((d) => d.date === open);
  const developers = openDay
    ? sort === 'commits'
      ? [...openDay.developers].sort(
          (a, b) =>
            b.commits - a.commits ||
            a.displayName.localeCompare(b.displayName),
        )
      : openDay.developers
    : [];

  return (
    <Card className="space-y-4">
      {header}

      <CommitChart
        series={days.map((d) => ({
          date: d.date,
          commits: d.totalCommits,
          locChanged: d.locChanged ?? 0,
        }))}
        windowDays={rangeDays(range)}
        endKey={rangeEndKey(range)}
        metric={metric}
        selectedDate={open}
        onSelectDay={(date) => setOpen(open === date ? null : date)}
      />

      {openDay ? (
        <div className="rounded-md border border-border bg-subtle p-3">
          <div className="mb-2 flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-medium text-fg-secondary">
              {formatDayKey(openDay.date)}
            </span>
            <span className="text-xs tabular-nums text-fg-subtle">
              {locAvailable && (
                <>
                  {(openDay.locChanged ?? 0).toLocaleString()} lines changed (+
                  {(openDay.additions ?? 0).toLocaleString()} −
                  {(openDay.deletions ?? 0).toLocaleString()}) ·{' '}
                </>
              )}
              {openDay.totalCommits} commit
              {openDay.totalCommits === 1 ? '' : 's'} ·{' '}
              {openDay.developers.length} developer
              {openDay.developers.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {developers.map((dev) => (
              <Link
                key={dev.developer}
                to={developerHref(dev.developer, range)}
                className="rounded bg-muted px-1.5 py-0.5 text-xs text-fg-secondary hover:bg-border"
              >
                {dev.displayName}
                <span className="ml-1 tabular-nums text-fg-subtle">
                  ×{dev.commits}
                </span>
              </Link>
            ))}
            {openDay.unattributedCommits > 0 && (
              <Badge tone="warn">
                +{openDay.unattributedCommits} unattributed
              </Badge>
            )}
          </div>
        </div>
      ) : (
        <p className="text-xs text-fg-faint">
          Select a day to see who committed.
        </p>
      )}

      {byLoc && (
        <ProvenanceNote>
          Bars are team totals of changed lines (added + removed) — volume, not
          productivity. Contributors are listed by commits, never by lines.
          {withoutLines > 0 && (
            <>
              {' '}
              {withoutLines} commit{withoutLines === 1 ? '' : 's'} in this
              window recorded no line changes (line stats not collected yet, or
              commits that change no lines), so line totals may be partial.
            </>
          )}
        </ProvenanceNote>
      )}
    </Card>
  );
}

function Header({
  sort,
  setSort,
  metric,
  setMetric,
}: {
  sort: 'name' | 'commits';
  setSort: (s: 'name' | 'commits') => void;
  metric: TrendMetric;
  /** Absent when the API sends no per-day LOC: there is nothing to toggle to. */
  setMetric?: (m: TrendMetric) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="font-semibold text-fg">
          {metric === 'loc'
            ? 'Lines of code changed over time'
            : 'Commits over time'}
        </h3>
        <p className="text-xs text-fg-subtle">
          One bar per IST day — select one to see that day’s contributors
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {setMetric && (
          <SegmentedControl
            label="Metric"
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'loc', label: 'Lines of code' },
              { value: 'commits', label: 'Commits' },
            ]}
          />
        )}
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
    </div>
  );
}
