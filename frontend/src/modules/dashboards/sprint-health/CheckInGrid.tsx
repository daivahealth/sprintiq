import { useEffect, useMemo, useState } from 'react';
import { Button, TableBodyRow, TableHeadRow } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { useSprintCheckIns, type CheckInRow } from '../useInsights';
import { ErrorCard, LoadingCard } from '../widgets';
import { checkInPages } from './pager';
import { DevName, SectionTitle, Panel } from './parts';
import { checkInBucket, formatDateRange, MOCKUP_HEAD, type CheckInBucket } from './presentation';

/**
 * IST date key ("2026-08-14") -> "Thu 14". No month: a page never spans more
 * than a week, so the month never changes mid-header and would only be noise.
 * Built by hand rather than with `{ weekday, day }` options, whose order
 * follows the browser locale ("14 Thu" in en-IN).
 */
function formatDayHeader(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
  return `${weekday} ${d.getUTCDate()}`;
}

/**
 * Cell weight relative to the busiest cell on the current page. Zero gets no
 * fill — the count still renders, just recessive, so a quiet day reads as
 * quiet rather than missing.
 */
const BUCKET_CLASS: Record<CheckInBucket, string> = {
  zero: 'text-fg-faint',
  low: 'bg-muted text-fg-muted',
  mid: 'bg-chart-3/15 text-chart-3',
  high: 'bg-success-bg font-bold text-success-fg',
};

/**
 * Sprint Health §Daily check-ins — ticket movement per developer per IST day,
 * paged seven days at a time within the sprint's own elapsed window
 * (`sprint-health-detail.service.ts#checkIns`, `./pager#checkInPages`).
 *
 * `sprint` is the only input this component needs. The elapsed window that
 * `checkInPages` requires (`CheckInsView.sprintFrom`/`sprintTo`) has no
 * legitimate source OUTSIDE this component: `SprintSummary.startAt`/`endAt`
 * are the sprint's PLANNED bounds, which `./pager` documents as the wrong
 * input — they would offer pages for days a running sprint has not reached
 * yet, and the backend clamps such a request to nothing. Computing
 * `min(endAt, now)` on the client would put timezone math back on the
 * client, which this codebase forbids outright. So the grid fetches once
 * with `from`/`to` unset — the backend already defaults to the sprint's
 * first seven elapsed days and returns `sprintFrom`/`sprintTo` on every
 * response — and derives its own pages from that response.
 *
 * `page === null` means "no explicit page yet": the hook is still called
 * with `from`/`to` unset, which is also exactly page one. That does NOT mean
 * the bootstrap fetch is safe from a second cache key forever, though: a
 * Prev/Next round trip (Next to page one, then Prev back to page zero) sets
 * `page` to the explicit index `0`, and `current` then resolves to page
 * zero's own concrete `from`/`to` — a different cache key from the initial
 * unset-bounds bootstrap call, so paging forward and back re-fetches rather
 * than reusing the bootstrap result.
 */
export function CheckInGrid({
  sprint,
  projects,
}: {
  sprint: string;
  /** Projects selected on the board — this sprint can span 25 of them. */
  projects: string[];
}) {
  const [page, setPage] = useState<number | null>(null);
  const [bounds, setBounds] = useState<{ from: string; to: string } | null>(null);

  // Reset during render, not in an effect: an effect would fire one frame
  // AFTER the sprint prop already changed, so the hook below would fetch one
  // stale combination (the old page/bounds against the new sprint) before
  // correcting itself. Adjusting here means that combination is never
  // requested at all. (https://react.dev/learn/you-might-not-need-an-effect
  // — "Adjusting state when a prop changes".)
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

  const query = useSprintCheckIns(
    sprint,
    projects,
    current?.from ?? null,
    current?.to ?? null,
  );
  const d = query.data;

  // Learn the elapsed window from whichever response lands — bootstrap or a
  // later explicit page — and keep it in sync if a running sprint's window
  // has grown since the last fetch.
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
  const active = current ?? pages[0];
  const shownRange =
    d && d.days.length > 0
      ? formatDateRange(d.days[0], d.days[d.days.length - 1])
      : null;

  return (
    <section>
      <SectionTitle
        title="Daily check-ins"
        echo="Jira tickets moved per developer, per day"
      />

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <span className="mb-1 block text-xs font-medium text-fg-subtle">
            Date range
          </span>
          {/* Read-only: the range is chosen with the pager, one sprint week
              at a time, so it never leaves the sprint's elapsed days. */}
          <div className="min-w-[13rem] rounded-md border border-border-strong bg-surface px-3 py-2 text-sm tabular-nums text-fg">
            {shownRange ?? '—'}
          </div>
        </div>
        {pages.length > 1 && (
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
              {active?.label}
              {active && (
                <span className="text-xs text-fg-faint">
                  {' '}
                  · sprint days {active.firstDay}–{active.lastDay}
                </span>
              )}
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

      {d && (
        <Panel>
          {d.rows.length === 0 ? (
            <p className="py-4 text-center text-sm text-fg-faint">
              No ticket movement recorded in this range.
            </p>
          ) : (
            // Wide content scrolls inside its own container — the page body
            // never scrolls sideways for it.
            <div className="overflow-x-auto">
              <CheckInTable days={d.days} rows={d.rows} />
            </div>
          )}

          <p className="mt-3 text-xs text-fg-faint">
            {bounds &&
              `Range limited to this sprint's elapsed days (${formatDateRange(bounds.from, bounds.to)}). `}
            Totals reflect only the selected range, not the full sprint. Counts
            every Jira status change, attributed to whoever made it — which is
            not always the assignee.
          </p>
        </Panel>
      )}
    </section>
  );
}

function CheckInTable({ days, rows }: { days: string[]; rows: CheckInRow[] }) {
  const max = Math.max(0, ...rows.flatMap((r) => r.counts));
  return (
    <table className="w-full min-w-[720px] text-sm">
      <thead>
        <TableHeadRow className={MOCKUP_HEAD}>
          <th className="py-2 pr-4">Developer</th>
          {days.map((day) => (
            <th key={day} className="px-1 py-2 text-center">
              {formatDayHeader(day)}
            </th>
          ))}
          <th className="py-2 pl-2 text-center">Total</th>
        </TableHeadRow>
      </thead>
      <tbody>
        {rows.map((row) => (
          <TableBodyRow key={row.developer}>
            <td className="py-2 pr-4">
              <DevName name={row.displayName} />
            </td>
            {row.counts.map((count, i) => (
              <td key={days[i]} className="px-1 py-2 text-center">
                <span
                  className={cn(
                    'inline-block min-w-[1.75rem] rounded px-1 py-0.5 tabular-nums',
                    BUCKET_CLASS[checkInBucket(count, max)],
                  )}
                >
                  {count}
                </span>
              </td>
            ))}
            <td className="py-2 pl-2 text-center font-bold tabular-nums text-fg">
              {row.total}
            </td>
          </TableBodyRow>
        ))}
      </tbody>
    </table>
  );
}
