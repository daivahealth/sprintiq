import { CalendarDays } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { MultiSelect } from '../../../components/multi-select';
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
import { sprintLabel, useOngoingSprintSelection } from '../ongoing-sprint';
import { useProjects } from '../useCatalog';
import {
  useActiveSprintsHealth,
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
 * (worklogs, by the day the work was started) and subtasks created. Expected
 * to change — the backend owns every rule (who appears, in what order, what is
 * disclosed), so this page only lays the figures out and states the rule.
 *
 * Shares the board's sprint selection through the URL (`?projects=&sprint=`),
 * so switching between Board and Efforts keeps the sprint being read.
 */
export function SprintHealthEffortsPage() {
  const { scope, setScope } = useScope();
  const [projectSearch, setProjectSearch] = useState('');
  const projects = useProjects(projectSearch);
  const hasProject = scope.projects.length > 0;
  const active = useActiveSprintsHealth(scope.projects);
  const { options, sprint, setSprint } = useOngoingSprintSelection(
    hasProject ? active.data?.rows : undefined,
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-[-0.035em] text-fg">
          Efforts
        </h2>
        <p className="text-sm text-fg-subtle">
          Jira hours logged and subtasks created per day, for the selected
          sprint. A record of what was logged — never a ranking.
        </p>
      </div>

      <FilterBar className="rounded-xl border bg-surface px-5 py-4">
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
          sprints={options.map((o) => o.sprint)}
          selected={sprint}
          onChange={setSprint}
          labelOf={(s) =>
            sprintLabel(
              options.find((o) => o.sprint.externalId === s.externalId) ?? {
                sprint: s,
              },
            )
          }
          placeholder={hasProject ? 'No ongoing sprint' : 'Pick a project first'}
        />
        <FreshnessNote />
      </FilterBar>

      {!hasProject && (
        <Card>
          <p className="py-4 text-center text-sm text-fg-faint">
            Pick a project to see its ongoing sprint.
          </p>
        </Card>
      )}
      {hasProject && active.isLoading && <LoadingCard />}
      {hasProject && active.isError && <ErrorCard error={active.error} />}
      {hasProject && active.data && !sprint && (
        <Card>
          <p className="py-4 text-center text-sm text-fg-faint">
            No ongoing sprint for this project.
          </p>
        </Card>
      )}
      {hasProject && sprint && (
        <EffortsGrid sprint={sprint} projects={scope.projects} />
      )}
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
function EffortsGrid({ sprint, projects }: { sprint: string; projects: string[] }) {
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
    projects,
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
        echo="Hours logged in Jira · subtasks created, per developer, per day"
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
                  {row.effortSeconds && row.subtasksCreated ? (
                    view.days.map((day, i) => (
                      <td key={day} className="px-1 py-2 text-center">
                        <EffortCell
                          seconds={row.effortSeconds![i]}
                          subtasks={row.subtasksCreated![i]}
                        />
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

/** Hours on top, subtasks created beneath; a quiet day reads as quiet, not missing. */
function EffortCell({ seconds, subtasks }: { seconds: number; subtasks: number }) {
  const quiet = seconds === 0 && subtasks === 0;
  return (
    <span
      className={
        quiet
          ? 'inline-flex flex-col items-center text-fg-faint'
          : 'inline-flex flex-col items-center rounded bg-muted px-1.5 py-0.5 text-fg-secondary'
      }
    >
      <span className="tabular-nums" title="Hours logged">
        {formatLogged(seconds)}
      </span>
      <span className="text-[10.5px] tabular-nums text-fg-faint" title="Subtasks created">
        {subtasks} {subtasks === 1 ? 'subtask' : 'subtasks'}
      </span>
    </span>
  );
}

/** IST date key → "Thu 14", same as the Check-ins grid header. */
function formatDayHeader(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
  return `${weekday} ${d.getUTCDate()}`;
}
