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
import { timeAgo } from '../../../lib/utils';
import {
  useDeveloperOverview,
  type ActiveDeveloper,
  type ActivityDay,
} from '../useInsights';
import { ErrorCard, LoadingCard, Stat } from '../widgets';
import { CurrentLensNote } from './CurrentLensNote';
import {
  EmptyWindowNote,
  formatDayKey,
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
      <ActiveDevelopers developers={d.activeDevelopers} range={range} />

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
              <th className="py-2 pr-4">Commits</th>
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
                <td className="py-2.5 pr-4 tabular-nums text-fg-muted">
                  {dev.commits}
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
        Activity context, never a ranking. Commits attributed to a known
        developer only — see data health below for what that leaves out.
      </ProvenanceNote>
    </Card>
  );
}

/**
 * Commits per day, where each bar opens that day's contributors.
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

  if (days.length === 0) {
    return (
      <Card className="space-y-4">
        <Header sort={sort} setSort={setSort} />
        {emptyState}
      </Card>
    );
  }

  // Oldest → newest for the chart; the API returns newest-first for the list.
  const chronological = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const max = Math.max(1, ...chronological.map((d) => d.totalCommits));
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
      <Header sort={sort} setSort={setSort} />

      <div
        className="flex h-40 items-end gap-1 overflow-x-auto"
        role="list"
        aria-label="Commits per day"
      >
        {chronological.map((day) => {
          const isOpen = day.date === open;
          return (
            <button
              key={day.date}
              type="button"
              role="listitem"
              onClick={() => setOpen(isOpen ? null : day.date)}
              title={`${formatDayKey(day.date)} — ${day.totalCommits} commits`}
              aria-expanded={isOpen}
              className="group flex min-w-[10px] flex-1 flex-col justify-end gap-1"
            >
              <span
                className={
                  isOpen
                    ? 'w-full rounded-sm bg-brand transition'
                    : 'w-full rounded-sm bg-brand/30 transition group-hover:bg-brand/60'
                }
                style={{
                  height: `${Math.max(2, (day.totalCommits / max) * 100)}%`,
                }}
              />
            </button>
          );
        })}
      </div>

      {openDay ? (
        <div className="rounded-md border border-border bg-subtle p-3">
          <div className="mb-2 flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-medium text-fg-secondary">
              {formatDayKey(openDay.date)}
            </span>
            <span className="text-xs tabular-nums text-fg-subtle">
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
    </Card>
  );
}

function Header({
  sort,
  setSort,
}: {
  sort: 'name' | 'commits';
  setSort: (s: 'name' | 'commits') => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="font-semibold text-fg">Commits over time</h3>
        <p className="text-xs text-fg-subtle">
          One bar per IST day — select one to see that day’s contributors
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
  );
}
