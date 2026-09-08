import { useState } from 'react';
import { Button, Card, TableBodyRow, TableHeadRow } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { useSprintCheckIns, type CheckInRow } from '../useInsights';
import { ErrorCard, LoadingCard } from '../widgets';
import { checkInPages } from './pager';

/**
 * IST date key ("2026-08-14") -> "Thu 14". No month: a page never spans more
 * than a week, so the month never changes mid-header and would only be noise.
 */
function formatDayHeader(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

/**
 * Background weight for a cell, relative to the busiest cell on the current
 * page. Zero gets none of it — the count itself still renders, just recessive
 * (`text-fg-faint`), so a quiet day reads as quiet rather than missing.
 */
function intensityClass(count: number, max: number): string {
  if (count === 0 || max === 0) return '';
  const ratio = count / max;
  if (ratio >= 0.75) return 'bg-chart-1/60';
  if (ratio >= 0.5) return 'bg-chart-1/40';
  if (ratio >= 0.25) return 'bg-chart-1/20';
  return 'bg-chart-1/10';
}

/**
 * Sprint Health §Daily check-ins — ticket movement per developer per IST day,
 * paged seven days at a time within the sprint's own elapsed window
 * (`sprint-health-detail.service.ts#checkIns`, `./pager#checkInPages`).
 *
 * `page` is local state indexing `checkInPages(sprintFrom, sprintTo)`; the
 * hook is called with the selected page's `from`/`to`. Prev/Next are disabled
 * at the ends so the range can never leave the sprint — there is nothing to
 * page to before day one or after the sprint's last elapsed day.
 */
export function CheckInGrid({
  sprint,
  sprintFrom,
  sprintTo,
}: {
  sprint: string;
  sprintFrom: string | null;
  sprintTo: string | null;
}) {
  // `checkInPages` already returns `[]` for empty strings, so a sprint whose
  // elapsed window is not yet known to the caller degrades to "no pager"
  // rather than throwing — the hook below still resolves a first page from
  // the backend's own default.
  const pages = checkInPages(sprintFrom ?? '', sprintTo ?? '');
  const [page, setPage] = useState(0);
  const current = pages[page];

  const query = useSprintCheckIns(sprint, current?.from ?? null, current?.to ?? null);
  const d = query.data;

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-fg">Daily check-ins</h3>
          <p className="text-xs text-fg-subtle">
            Ticket movement per developer, one column per day
          </p>
        </div>
        {pages.length > 1 && (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Prev
            </Button>
            <span className="text-xs tabular-nums text-fg-subtle">
              {current?.label}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= pages.length - 1}
              onClick={() => setPage((p) => Math.min(pages.length - 1, p + 1))}
            >
              Next
            </Button>
          </div>
        )}
      </div>

      {query.isLoading && <LoadingCard />}
      {query.isError && <ErrorCard error={query.error} />}

      {d && (
        <>
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
            Counts every Jira status change, attributed to whoever made it —
            which is not always the assignee. Range is limited to this
            sprint's active days; totals cover the selected range, not the
            whole sprint.
          </p>
        </>
      )}
    </Card>
  );
}

function CheckInTable({ days, rows }: { days: string[]; rows: CheckInRow[] }) {
  const max = Math.max(0, ...rows.flatMap((r) => r.counts));
  return (
    <table className="min-w-full text-sm">
      <thead>
        <TableHeadRow>
          <th className="py-2 pr-4">Developer</th>
          {days.map((day) => (
            <th key={day} className="py-2 px-2 text-center">
              {formatDayHeader(day)}
            </th>
          ))}
          <th className="py-2 pl-2 text-right">Total</th>
        </TableHeadRow>
      </thead>
      <tbody>
        {rows.map((row) => (
          <TableBodyRow key={row.developer}>
            <td className="py-2.5 pr-4 font-medium text-fg-secondary">
              {row.displayName}
            </td>
            {row.counts.map((count, i) => (
              <td
                key={days[i]}
                className={cn(
                  'py-2.5 px-2 text-center tabular-nums',
                  intensityClass(count, max),
                  count === 0 ? 'text-fg-faint' : 'text-fg',
                )}
              >
                {count}
              </td>
            ))}
            <td className="py-2.5 pl-2 text-right font-medium tabular-nums text-fg-secondary">
              {row.total}
            </td>
          </TableBodyRow>
        ))}
      </tbody>
    </table>
  );
}
