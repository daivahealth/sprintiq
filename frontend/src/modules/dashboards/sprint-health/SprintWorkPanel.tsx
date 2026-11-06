import { useState } from 'react';
import {
  Badge,
  Card,
  SegmentedControl,
  StatusDot,
  TableBodyRow,
  TableHeadRow,
} from '../../../components/ui';
import { Stat, TypeBadge } from '../widgets';
import type {
  CodeState,
  DataGapKind,
  JiraStatusBucket,
  SprintTicketRow,
  SprintWorkBreakdownView,
} from '../useInsights';
import { DataGapsList } from './DataGapsList';
import { GAP_COPY } from './gap-copy';

/**
 * Sprint Health §Sprint work — the sprint's Jira structure for the selected
 * project, each ticket beside what GitHub says about its code
 * (`sprint-health-detail.service.ts#workBreakdown`).
 *
 * Two sources, two jobs: Jira owns the workflow (status, board column, done,
 * points) and GitHub owns the code (PR state, commits). Where they disagree
 * the row is flagged rather than one overwriting the other — "Ready for QA"
 * with a merged PR is both true, and QA is work GitHub cannot see.
 */

const BUCKET_LABEL: Record<JiraStatusBucket, string> = {
  todo: 'To do',
  'in-progress': 'In progress',
  done: 'Done',
};

const CODE_LABEL: Record<CodeState, string> = {
  merged: 'Merged',
  'in-review': 'In review',
  committed: 'Committed',
  none: 'No code',
};

const CODE_TONE: Record<CodeState, 'good' | 'warn' | 'neutral'> = {
  merged: 'good',
  'in-review': 'warn',
  committed: 'neutral',
  none: 'neutral',
};

type Filter = 'all' | JiraStatusBucket | 'needs-update';

/** Gaps that are context, not a record to fix — they don't make a row "needs update". */
const INFO_GAPS: DataGapKind[] = ['in-qa', 'no-code-linked'];

const needsUpdate = (t: SprintTicketRow) =>
  (t.gaps ?? []).some((g) => !INFO_GAPS.includes(g));

/** Rows shown before "Show all" — ACT's sprint alone has 260 work items. */
const PAGE = 25;

export function SprintWorkPanel({ data }: { data: SprintWorkBreakdownView }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [showAll, setShowAll] = useState(false);

  const total = data.tickets.length;
  const clashCount = data.clashes.githubAhead + data.clashes.jiraAhead;
  const needsUpdateCount = data.tickets.filter(needsUpdate).length;
  const project = data.tickets[0]?.key.split('-')[0] ?? 'PROJ';
  const rows = data.tickets.filter((t) =>
    filter === 'all'
      ? true
      : filter === 'needs-update'
        ? needsUpdate(t)
        : t.bucket === filter,
  );
  const visible = showAll ? rows : rows.slice(0, PAGE);

  return (
    <Card className="space-y-5">
      <div>
        <h3 className="font-semibold text-fg">Sprint work</h3>
        <p className="text-xs text-fg-subtle">
          Jira for workflow and points, GitHub for code. Counted as the Jira board counts
          them: work items only (subtasks roll into their parent), by status category.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {(['todo', 'in-progress', 'done'] as const).map((b) => (
          <Stat
            key={b}
            label={BUCKET_LABEL[b]}
            value={data.buckets[b].items}
            hint={`${data.buckets[b].points} pts`}
          />
        ))}
      </div>
      <ColumnBar data={data} total={total} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-fg-muted">
        {data.byType.map((t) => (
          <span key={t.type} className="inline-flex items-center gap-1.5">
            <TypeBadge type={t.type} />
            <span className="tabular-nums">
              {t.done}/{t.items} done
            </span>
          </span>
        ))}
        {data.subtasks.total > 0 && (
          <span className="tabular-nums">
            {data.subtasks.done}/{data.subtasks.total} subtasks done
          </span>
        )}
        {data.unestimated > 0 && (
          <span className="tabular-nums text-fg-subtle">
            {data.unestimated} unestimated
          </span>
        )}
        {data.unassigned > 0 && (
          <span className="tabular-nums text-fg-subtle">
            {data.unassigned} unassigned
          </span>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-sm font-medium text-fg-muted">Code (GitHub)</h4>
        <div className="grid gap-3 sm:grid-cols-4">
          {(['merged', 'in-review', 'committed', 'none'] as const).map((s) => (
            <Stat key={s} label={CODE_LABEL[s]} value={data.code[s]} />
          ))}
        </div>
        <p className="mt-2 text-xs text-fg-faint">
          {clashCount === 0
            ? 'Jira and GitHub agree on every ticket.'
            : [
                data.clashes.githubAhead > 0 &&
                  `${data.clashes.githubAhead} with merged code that Jira hasn't moved to done (often waiting on QA or UAT)`,
                data.clashes.jiraAhead > 0 &&
                  `${data.clashes.jiraAhead} done in Jira whose only PRs are still open`,
              ]
                .filter(Boolean)
                .join('; ') +
              '. Flagged below, not overridden: the done count stays Jira’s.'}{' '}
          Code is found by the ticket key in a commit message, branch or PR.
        </p>
      </div>

      {data.gaps && <DataGapsList gaps={data.gaps} project={project} />}

      {data.epics.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-fg-muted">By epic</h4>
          <div className="space-y-1.5">
            {data.epics.map((e) => (
              <div key={e.key ?? '-'} className="flex items-center gap-3 text-sm">
                <span className="w-64 min-w-0 truncate text-fg-muted">
                  {e.key ? (
                    <>
                      <span className="font-medium text-fg-secondary">{e.key}</span>{' '}
                      {e.title ?? ''}
                    </>
                  ) : (
                    <span className="italic text-fg-subtle">No epic</span>
                  )}
                </span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-success"
                    style={{
                      width: `${e.items ? (e.done / e.items) * 100 : 0}%`,
                    }}
                  />
                </div>
                <span className="w-28 text-right text-xs tabular-nums text-fg-secondary">
                  {e.done}/{e.items} · {e.points} pts
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <h4 className="text-sm font-medium text-fg-muted">Tickets</h4>
          <SegmentedControl<Filter>
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setShowAll(false);
            }}
            options={[
              { value: 'all', label: `All ${total}` },
              {
                value: 'in-progress',
                label: `In progress ${data.buckets['in-progress'].items}`,
              },
              { value: 'todo', label: `To do ${data.buckets.todo.items}` },
              { value: 'done', label: `Done ${data.buckets.done.items}` },
              { value: 'needs-update', label: `Needs update ${needsUpdateCount}` },
            ]}
          />
        </div>
        <TicketTable rows={visible} />
        {rows.length > PAGE && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="mt-2 text-xs font-medium text-brand-fg hover:underline"
          >
            {showAll ? `Show first ${PAGE}` : `Show all ${rows.length}`}
          </button>
        )}
      </div>
    </Card>
  );
}

/** Jira's three columns as one bar, by item count. */
function ColumnBar({ data, total }: { data: SprintWorkBreakdownView; total: number }) {
  if (total === 0) {
    return null;
  }
  const w = (b: JiraStatusBucket) => `${(data.buckets[b].items / total) * 100}%`;
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full bg-fg-faint" style={{ width: w('todo') }} />
      <div className="h-full bg-brand" style={{ width: w('in-progress') }} />
      <div className="h-full bg-success" style={{ width: w('done') }} />
    </div>
  );
}

function TicketTable({ rows }: { rows: SprintTicketRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-fg-faint">No tickets in this view.</p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[960px] table-fixed text-sm">
        <colgroup>
          <col className="w-[28%]" />
          <col className="w-[7%]" />
          <col className="w-[15%]" />
          <col className="w-[5%]" />
          <col className="w-[12%]" />
          <col className="w-[8%]" />
          <col className="w-[25%]" />
        </colgroup>
        <thead>
          <TableHeadRow>
            <th className="py-2 pr-4 font-medium">Item</th>
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 pr-4 font-medium">Jira status</th>
            <th className="py-2 pr-4 font-medium">Pts</th>
            <th className="py-2 pr-4 font-medium">Assignee</th>
            <th className="py-2 pr-4 font-medium">Subtasks</th>
            <th className="py-2 font-medium">Code (GitHub)</th>
          </TableHeadRow>
        </thead>
        <tbody>
          {rows.map((t) => (
            <TableBodyRow key={t.key}>
              <td className="py-2.5 pr-4">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-medium text-fg-secondary">{t.key}</span>
                  <span className="min-w-0 truncate text-fg-subtle" title={t.title}>
                    {t.title}
                  </span>
                </div>
                {t.epicKey && (
                  <div className="text-[11px] text-fg-faint">{t.epicKey}</div>
                )}
              </td>
              <td className="py-2.5 pr-4">
                <TypeBadge type={t.type} />
              </td>
              <td className="py-2.5 pr-4">
                <Badge tone={t.bucket === 'done' ? 'good' : 'neutral'}>{t.status}</Badge>
              </td>
              <td className="py-2.5 pr-4 tabular-nums">{t.storyPoints ?? '—'}</td>
              <td className="truncate py-2.5 pr-4 text-fg-muted">
                {t.assigneeName ?? '—'}
              </td>
              <td className="py-2.5 pr-4 tabular-nums text-fg-muted">
                {t.subtasks.total > 0 ? `${t.subtasks.done}/${t.subtasks.total}` : '—'}
              </td>
              <td className="py-2.5">
                <CodeCell ticket={t} />
              </td>
            </TableBodyRow>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeCell({ ticket }: { ticket: SprintTicketRow }) {
  const { code } = ticket;
  const gaps = ticket.gaps ?? [];
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={CODE_TONE[code.state]}>{CODE_LABEL[code.state]}</Badge>
        {code.commits > 0 && (
          <span className="text-xs tabular-nums text-fg-subtle">
            {code.commits} commit{code.commits === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {gaps.length > 0 && (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5">
          {gaps.map((g) => (
            <span
              key={g}
              className={
                INFO_GAPS.includes(g)
                  ? 'text-xs text-fg-subtle'
                  : 'text-xs font-medium text-warning-fg'
              }
              title={GAP_COPY[g].fix(ticket.key.split('-')[0] ?? 'PROJ')}
            >
              {INFO_GAPS.includes(g) ? '' : '⚑ '}
              {GAP_COPY[g].label}
            </span>
          ))}
        </div>
      )}
      {code.prs.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {code.prs.map((pr) => (
            <span
              key={pr.ref}
              className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-fg-muted"
            >
              {pr.ref.split('/').pop()}
              <StatusDot
                tone={
                  pr.state === 'merged'
                    ? 'good'
                    : pr.state === 'open'
                      ? 'warn'
                      : 'neutral'
                }
              />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
