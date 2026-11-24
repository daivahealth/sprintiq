import { CalendarDays } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  FilterBar,
  ProvenanceNote,
  TableBodyRow,
  TableHeadRow,
} from '../../../components/ui';
import { useScope } from '../../../lib/scope';
import { timeAgo } from '../../../lib/utils';
import { FreshnessNote } from '../FreshnessNote';
import {
  useEffortsSprints,
  useSprintEfforts,
  type EffortsView,
} from '../useInsights';
import { ErrorCard, LoadingCard, SprintPicker } from '../widgets';
import { effortsDisclosures, formatLogged } from './efforts-format';
import { checkInPages } from './pager';
import { DevName, Panel, SectionTitle } from './parts';
import { formatDateRange, MOCKUP_HEAD } from './presentation';

/**
 * Sprint Health → Efforts (DASHBOARDS.md §4.1.5, ADR-0014). Admin only.
 *
 * Daily Jira check-ins for the first ten tracked developers, A–Z: hours logged
 * (worklogs, by the day the work was started). Expected to change — the
 * backend owns every rule (who appears, in what order, what is disclosed), so
 * this page only lays the figures out and states the rule.
 *
 * No project filter (2026-11-24): the people are a fixed list, independent of
 * any project, so their hours are read across the whole sprint. The picker
 * lists every ongoing sprint in the tenant, newest first. The choice is kept
 * in the URL's `?sprint=`, shared with the Board — which still validates it
 * against its own projects' sprints.
 */
export function SprintHealthEffortsPage() {
  const { scope, setScope } = useScope();
  const sprints = useEffortsSprints();
  const options = sprints.data?.sprints ?? [];
  // The URL's sprint when it is one of the ongoing ones, else the newest.
  const sprint =
    options.find((s) => s.externalId === scope.sprint)?.externalId ??
    options[0]?.externalId ??
    null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-[-0.035em] text-fg">
          Efforts
        </h2>
        <p className="text-sm text-fg-subtle">
          Jira hours logged per day across the whole sprint, every project. A
          record of what was logged — never a ranking.
        </p>
      </div>

      <FilterBar className="rounded-xl border bg-surface px-5 py-4">
        <SprintPicker
          sprints={options}
          selected={sprint}
          onChange={(externalId) => setScope({ sprint: externalId })}
          labelOf={(s) => s.name}
          placeholder={sprints.isLoading ? 'Loading sprints…' : 'No ongoing sprint'}
        />
        <FreshnessNote />
      </FilterBar>

      {sprints.isLoading && <LoadingCard />}
      {sprints.isError && <ErrorCard error={sprints.error} />}
      {sprints.data && !sprint && (
        <Card>
          <p className="py-4 text-center text-sm text-fg-faint">
            No ongoing sprint.
          </p>
        </Card>
      )}
      {sprint && <EffortsGrid sprint={sprint} />}
    </div>
  );
}

/**
 * The week-paged grid. Same bootstrap as `CheckInGrid`: the first fetch goes
 * out with no range (the backend defaults to the sprint's first seven elapsed
 * days and reports the elapsed window), and the pages are built from that
 * response — never from the sprint's planned bounds, and with no timezone
 * math on the client.
 */
function EffortsGrid({ sprint }: { sprint: string }) {
  const [page, setPage] = useState<number | null>(null);
  const [bounds, setBounds] = useState<{ from: string; to: string } | null>(null);
  const [trackedSprint, setTrackedSprint] = useState(sprint);
  if (sprint !== trackedSprint) {
    setTrackedSprint(sprint);
    setPage(null);
    setBounds(null);
  }

  const pages = useMemo(
    () => (bounds ? checkInPages(bounds.from, bounds.to) : []),
    [bounds],
  );
  const current = page === null ? undefined : pages[page];
  const query = useSprintEfforts(
    sprint,
    current?.from ?? null,
    current?.to ?? null,
  );
  const d = query.data;

  useEffect(() => {
    if (d?.sprintFrom && d?.sprintTo) {
      const sprintFrom = d.sprintFrom;
      const sprintTo = d.sprintTo;
      setBounds((prev) =>
        prev && prev.from === sprintFrom && prev.to === sprintTo
          ? prev
          : { from: sprintFrom, to: sprintTo },
      );
    }
  }, [d?.sprintFrom, d?.sprintTo]);

  const activePage = page ?? 0;
  const activeWeek = current ?? pages[0];
  const shownRange =
    d && d.days.length > 0
      ? formatDateRange(d.days[0], d.days[d.days.length - 1])
      : null;

  return (
    <section>
      <SectionTitle
        title="Daily efforts"
        echo="Hours logged in Jira, per developer, per day"
      />

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <span className="mb-1 block text-xs font-medium text-fg-subtle">
            Date range
          </span>
          <div className="flex min-w-[13rem] items-center justify-between gap-2.5 rounded-md border border-border-strong bg-surface px-3.5 py-2 text-sm tabular-nums text-fg">
            {shownRange ?? '—'}
            <CalendarDays aria-hidden className="h-3.5 w-3.5 text-fg-faint" />
          </div>
        </div>
        {activeWeek && (
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              aria-label="Previous week"
              disabled={activePage <= 0}
              onClick={() => setPage(Math.max(0, activePage - 1))}
            >
              ‹ Prev
            </Button>
            <span className="whitespace-nowrap text-sm text-fg-subtle">
              {activeWeek.label}
              <span className="text-xs text-fg-faint">
                {' '}
                · sprint days {activeWeek.firstDay}–{activeWeek.lastDay}
              </span>
            </span>
            <Button
              variant="secondary"
              size="sm"
              aria-label="Next week"
              disabled={activePage >= pages.length - 1}
              onClick={() => setPage(Math.min(pages.length - 1, activePage + 1))}
            >
              Next ›
            </Button>
          </div>
        )}
      </div>

      {query.isLoading && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}
      {d && <EffortsPanel view={d} />}
    </section>
  );
}

function EffortsPanel({ view }: { view: EffortsView }) {
  const notes = effortsDisclosures(view);
  return (
    <Panel>
      {view.roster.tracked === 0 ? (
        <p className="py-4 text-center text-sm text-fg-faint">
          No tracked developers yet. Admins add them under Engineering Activity
          → Developers with No GH-Recorded Activity.
        </p>
      ) : view.rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-fg-faint">
          None of the tracked developers can be shown — see the notes below.
        </p>
      ) : (
        // Wide content scrolls inside its own container — never the page.
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <TableHeadRow className={MOCKUP_HEAD}>
                <th className="py-2 pr-4">Developer</th>
                {view.days.map((day) => (
                  <th key={day} className="px-1 py-2 text-center">
                    {formatDayHeader(day)}
                  </th>
                ))}
              </TableHeadRow>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <TableBodyRow key={row.developer}>
                  <td className="py-2 pr-4">
                    <DevName name={row.displayName} />
                  </td>
                  {row.effortSeconds ? (
                    view.days.map((day, i) => (
                      <td key={day} className="px-1 py-2 text-center">
                        <EffortCell seconds={row.effortSeconds![i]} />
                      </td>
                    ))
                  ) : (
                    <td
                      colSpan={view.days.length}
                      className="px-1 py-2 text-center text-xs text-fg-faint"
                    >
                      No Jira account linked — nothing can be shown for this
                      developer.
                    </td>
                  )}
                </TableBodyRow>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The rule ships with the figures (ADR-0014 condition 1). */}
      <p className="mt-4 rounded-md border border-border bg-subtle p-3 text-xs text-fg-muted">
        {view.rule}
      </p>
      {notes.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-fg-faint">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <ProvenanceNote>Computed {timeAgo(view.computedAt)}.</ProvenanceNote>
    </Panel>
  );
}

/** Hours logged that day; a quiet day reads as quiet, not missing. */
function EffortCell({ seconds }: { seconds: number }) {
  return (
    <span
      title="Hours logged"
      className={
        seconds === 0
          ? 'inline-block tabular-nums text-fg-faint'
          : 'inline-block rounded bg-muted px-1.5 py-0.5 tabular-nums text-fg-secondary'
      }
    >
      {formatLogged(seconds)}
    </span>
  );
}

/** IST date key → "Thu 14", same as the Check-ins grid header. */
function formatDayHeader(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
  return `${weekday} ${d.getUTCDate()}`;
}
