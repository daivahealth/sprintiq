import { Badge, Card, TableBodyRow, TableHeadRow } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import type { ProductivityGrade, ProductivityView } from '../useInsights';
import { DevName, SectionTitle } from './parts';

const GRADE_TONE: Record<ProductivityGrade, 'good' | 'warn' | 'bad'> = {
  high: 'good',
  medium: 'warn',
  low: 'bad',
};

/**
 * Sprint Health §Team & individual productivity — per-developer table graded
 * high/medium/low (`sprint-health-detail.service.ts#productivity`).
 *
 * The grade is cut from tickets worked + PRs raised + reviews submitted,
 * never from LOC — `gradeRule` ships with the data and is printed verbatim
 * under the table, because a graded person is entitled to check the rule
 * they were graded by rather than trust the pill.
 *
 * Rows keep the backend's order (grade score), never LOC: the LOC column is
 * context, and ordering people by it would turn it into the ranking the
 * ethics rule forbids (CLAUDE.md, decided 2026-09-07).
 */
export function ProductivityPanel({ data }: { data: ProductivityView }) {
  return (
    <section>
      <SectionTitle
        title="Team & individual productivity"
        echo="tickets worked, commits, PR activity — this sprint"
      />

      {/* Rendered only once there are enough contributors to rank — see
          `highest`/`lowest`'s null case. Names withheld: this is a volume
          signal, not an attributed leaderboard. */}
      {data.highest !== null && data.lowest !== null && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <LocCard tone="high" additions={data.highest.additions} />
            <LocCard tone="low" additions={data.lowest.additions} />
          </div>
          <p className="mb-3 mt-2 text-xs text-fg-faint">
            Names withheld above — LOC is volume, not a score. The table below
            is the full, attributed breakdown; its grade never uses LOC.
          </p>
        </>
      )}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <TableHeadRow>
                <th className="py-2 pr-4">Developer</th>
                <th className="py-2 pr-4 text-right">Lines of code</th>
                <th className="py-2 pr-4 text-right">Tickets worked</th>
                <th className="py-2 pr-4 text-right">Commits</th>
                <th className="py-2 pr-4 text-right">PRs raised</th>
                <th className="py-2 pr-4 text-right">PRs reviewed</th>
                <th className="py-2">Productivity</th>
              </TableHeadRow>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <TableBodyRow key={row.developer}>
                  <td className="py-2.5 pr-4">
                    <DevName name={row.displayName} />
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-4 text-right tabular-nums">
                    <span className="font-semibold text-success-fg">
                      +{row.additions.toLocaleString()}
                    </span>{' '}
                    <span className="text-xs font-semibold text-danger-fg">
                      −{row.deletions.toLocaleString()}
                    </span>
                  </td>
                  <Num>{row.ticketsWorked}</Num>
                  <Num>{row.commits}</Num>
                  <Num>{row.prsRaised}</Num>
                  <Num>{row.prsReviewed}</Num>
                  <td className="py-2.5">
                    <Badge tone={GRADE_TONE[row.grade]}>{row.grade}</Badge>
                  </td>
                </TableBodyRow>
              ))}
              {data.rows.length === 0 && (
                <TableBodyRow>
                  <td colSpan={7} className="py-4 text-center text-sm text-fg-faint">
                    No attributed activity in this sprint.
                  </td>
                </TableBodyRow>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-xs text-fg-faint">{data.gradeRule}</p>
        <p className="mt-1 text-xs text-fg-faint">
          Commits, LOC, PRs and reviews count only work linked to this
          sprint&apos;s tickets — a commit that names no sprint ticket is not
          on this table.
        </p>
      </Card>
    </section>
  );
}

function Num({ children }: { children: number }) {
  return (
    <td className="py-2.5 pr-4 text-right tabular-nums text-fg-muted">{children}</td>
  );
}

/** One of the two name-withheld LOC cards. */
function LocCard({ tone, additions }: { tone: 'high' | 'low'; additions: number }) {
  const high = tone === 'high';
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border p-4',
        high ? 'border-success-border bg-success-bg' : 'border-danger-border bg-danger-bg',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex h-9 w-9 flex-none items-center justify-center rounded-full border border-border-subtle bg-surface text-sm',
          high ? 'text-success-fg' : 'text-danger-fg',
        )}
      >
        {high ? '▲' : '▼'}
      </span>
      <div>
        <div
          className={cn(
            'text-[11px] font-bold uppercase tracking-[0.04em]',
            high ? 'text-success-fg' : 'text-danger-fg',
          )}
        >
          {high ? 'Highest' : 'Lowest'} LOC contributor
        </div>
        <div className="text-lg font-bold tabular-nums text-fg">
          {additions.toLocaleString()} LOC added
        </div>
        <div className="text-xs text-fg-subtle">
          lines added this sprint, in work linked to its tickets
        </div>
      </div>
    </div>
  );
}
