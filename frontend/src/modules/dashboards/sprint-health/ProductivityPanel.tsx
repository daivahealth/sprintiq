import { Badge, Card, TableBodyRow, TableHeadRow } from '../../../components/ui';
import { Stat } from '../widgets';
import type { ProductivityGrade, ProductivityView } from '../useInsights';

const GRADE_TONE: Record<ProductivityGrade, 'good' | 'neutral' | 'warn'> = {
  high: 'good',
  medium: 'neutral',
  low: 'warn',
};

/**
 * Sprint Health §Productivity — per-developer table graded high/medium/low
 * (`sprint-health-detail.service.ts#productivity`).
 *
 * The grade is cut from tickets worked + PRs raised + reviews submitted,
 * never from LOC — `gradeRule` ships with the data and is printed verbatim
 * under the table, because a graded person is entitled to check the rule
 * they were graded by rather than trust the pill.
 */
export function ProductivityPanel({ data }: { data: ProductivityView }) {
  return (
    <Card className="space-y-4">
      <h3 className="font-semibold text-fg">Productivity</h3>

      {/* Rendered only once there are enough contributors to rank — see
          `highest`/`lowest`'s null case below. Names withheld: this is a
          volume signal, not an attributed leaderboard. */}
      {data.highest !== null && data.lowest !== null && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Stat
            label="Highest LOC contributor"
            value={`+${data.highest.additions.toLocaleString()}`}
            hint="name withheld — LOC is volume, not a score"
          />
          <Stat
            label="Lowest LOC contributor"
            value={`+${data.lowest.additions.toLocaleString()}`}
            hint="name withheld — LOC is volume, not a score"
          />
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <TableHeadRow>
              <th className="py-2 pr-4 font-medium">Developer</th>
              <th className="py-2 pr-4 font-medium">LOC</th>
              <th className="py-2 pr-4 font-medium">Tickets worked</th>
              <th className="py-2 pr-4 font-medium">Commits</th>
              <th className="py-2 pr-4 font-medium">PRs raised</th>
              <th className="py-2 pr-4 font-medium">PRs reviewed</th>
              <th className="py-2 font-medium">Grade</th>
            </TableHeadRow>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <TableBodyRow key={row.developer}>
                <td className="py-2.5 pr-4 font-medium text-fg-secondary">
                  {row.displayName}
                </td>
                <td className="py-2.5 pr-4 tabular-nums text-xs">
                  <span className="text-success-fg">
                    +{row.additions.toLocaleString()}
                  </span>{' '}
                  <span className="text-danger-fg">
                    −{row.deletions.toLocaleString()}
                  </span>
                </td>
                <td className="py-2.5 pr-4 tabular-nums text-fg-muted">
                  {row.ticketsWorked}
                </td>
                <td className="py-2.5 pr-4 tabular-nums text-fg-muted">
                  {row.commits}
                </td>
                <td className="py-2.5 pr-4 tabular-nums text-fg-muted">
                  {row.prsRaised}
                </td>
                <td className="py-2.5 pr-4 tabular-nums text-fg-muted">
                  {row.prsReviewed}
                </td>
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
    </Card>
  );
}
