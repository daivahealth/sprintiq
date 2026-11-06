import { Fragment, useMemo, useState } from 'react';
import {
  Badge,
  Card,
  SegmentedControl,
  StatusDot,
  TableBodyRow,
  TableHeadRow,
} from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { TypeBadge } from '../widgets';
import type {
  CodeState,
  JiraStatusBucket,
  SprintTicketRow,
  SprintWorkBreakdownView,
} from '../useInsights';
import { DataGapsList } from './DataGapsList';
import { GAP_COPY } from './gap-copy';
import { MetalStat, Tip } from './metal';
import {
  INFO_GAPS,
  NO_EPIC,
  filterTickets,
  needsUpdate,
  sortTickets,
  type SortKey,
  type TicketFilter,
} from './ticket-view';

/**
 * Sprint Health §Sprint work — the sprint's Jira structure for the selected
 * project, each ticket beside what GitHub says about its code
 * (`sprint-health-detail.service.ts#workBreakdown`).
 *
 * Two sources, two jobs: Jira owns the workflow (status, board column, done,
 * points) and GitHub owns the code (PR state, commits). Where they disagree
 * the row is flagged rather than one overwriting the other — "Ready for QA"
 * with a merged PR is both true, and QA is work GitHub cannot see.
 *
 * Every summary is also a way into the table: clicking a column tile, a code
 * tile, an epic or a per-ticket gap filters the tickets to the ones behind it.
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

const CODE_HINT: Record<CodeState, string> = {
  merged: 'a linked PR is merged',
  'in-review': 'a PR is open, none merged',
  committed: 'commits name it, no PR',
  none: 'nothing on GitHub names it',
};

const CODE_TONE: Record<CodeState, 'good' | 'warn' | 'neutral'> = {
  merged: 'good',
  'in-review': 'warn',
  committed: 'neutral',
  none: 'neutral',
};

/** Rows shown before "Show all" — ACT's sprint alone has 260 work items. */
const PAGE = 25;

export function SprintWorkPanel({ data }: { data: SprintWorkBreakdownView }) {
  const [filter, setFilter] = useState<TicketFilter>({});
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'default',
    desc: false,
  });
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const total = data.tickets.length;
  const needsUpdateCount = data.tickets.filter(needsUpdate).length;
  const project = data.tickets[0]?.key.split('-')[0] ?? 'PROJ';
  const epicTitle = new Map(data.epics.map((e) => [e.key ?? NO_EPIC, e.title]));

  /** Toggle one filter axis: picking the active value again clears it. */
  const toggle = <K extends keyof TicketFilter>(key: K, value: TicketFilter[K]) => {
    setFilter((f) => ({ ...f, [key]: f[key] === value ? undefined : value }));
    setShowAll(false);
  };

  const rows = useMemo(
    () => sortTickets(filterTickets(data.tickets, filter), sort),
    [data.tickets, filter, sort],
  );
  const visible = showAll ? rows : rows.slice(0, PAGE);

  const chips: { label: string; clear: () => void }[] = [
    filter.bucket && {
      label: `Jira: ${BUCKET_LABEL[filter.bucket]}`,
      clear: () => toggle('bucket', filter.bucket),
    },
    filter.code && {
      label: `Code: ${CODE_LABEL[filter.code]}`,
      clear: () => toggle('code', filter.code),
    },
    filter.epic && {
      label:
        filter.epic === NO_EPIC
          ? 'No epic'
          : `Epic: ${filter.epic}${epicTitle.get(filter.epic) ? ` ${epicTitle.get(filter.epic)}` : ''}`,
      clear: () => toggle('epic', filter.epic),
    },
    filter.gap && {
      label: filter.gap === 'needs-update' ? 'Needs update' : GAP_COPY[filter.gap].label,
      clear: () => toggle('gap', filter.gap),
    },
  ].filter((c): c is { label: string; clear: () => void } => Boolean(c));

  const segment =
    filter.gap === 'needs-update' ? 'needs-update' : (filter.bucket ?? 'all');

  return (
    <Card className="space-y-5">
      <div>
        <h3 className="font-semibold text-fg">Sprint work</h3>
        <p className="text-xs text-fg-subtle">
          Jira for workflow and points, GitHub for code. Counted as the Jira board counts
          them: work items only (subtasks roll into their parent), by status category.
          Click any tile, epic or gap to see the tickets behind it.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {(['todo', 'in-progress', 'done'] as const).map((b) => (
          <MetalStat
            key={b}
            label={BUCKET_LABEL[b]}
            value={data.buckets[b].items}
            hint={`${data.buckets[b].points} pts`}
            active={filter.bucket === b}
            onClick={() => toggle('bucket', b)}
            title={`Show the ${data.buckets[b].items} tickets Jira has in ${BUCKET_LABEL[b]}`}
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
            <MetalStat
              key={s}
              label={CODE_LABEL[s]}
              value={data.code[s]}
              hint={CODE_HINT[s]}
              active={filter.code === s}
              onClick={() => toggle('code', s)}
            />
          ))}
        </div>
        <p className="mt-2 text-xs text-fg-faint">
          Code is found by the ticket key in a commit message, branch or PR; a subtask’s
          code counts for its parent. GitHub never changes Jira’s done count.
        </p>
      </div>

      {data.gaps && (
        <DataGapsList
          gaps={data.gaps}
          project={project}
          active={filter.gap === 'needs-update' ? undefined : filter.gap}
          onSelect={(kind) => toggle('gap', kind)}
        />
      )}

      {data.epics.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-fg-muted">By epic</h4>
          <div className="space-y-1">
            {data.epics.map((e) => {
              const id = e.key ?? NO_EPIC;
              const pct = e.items ? Math.round((e.done / e.items) * 100) : 0;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggle('epic', id)}
                  aria-pressed={filter.epic === id}
                  className={cn(
                    'flex w-full items-center gap-3 rounded px-1.5 py-1 text-left text-sm transition hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
                    filter.epic === id && 'bg-subtle ring-1 ring-brand/40',
                  )}
                >
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
                  <Tip
                    className="flex-1"
                    content={`${e.done} of ${e.items} work items done (${pct}%) · ${e.points} pts`}
                  >
                    <span className="block h-2.5 w-full overflow-hidden rounded-full bg-muted">
                      <span
                        className="metal-bar block h-full rounded-full bg-success"
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                  </Tip>
                  <span className="w-28 text-right text-xs tabular-nums text-fg-secondary">
                    {e.done}/{e.items} · {e.points} pts
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <h4 className="text-sm font-medium text-fg-muted">
            Tickets{' '}
            <span className="tabular-nums text-fg-faint">
              {rows.length === total ? total : `${rows.length} of ${total}`}
            </span>
          </h4>
          <SegmentedControl<JiraStatusBucket | 'all' | 'needs-update'>
            value={segment}
            onChange={(v) => {
              setFilter((f) => ({
                ...f,
                bucket: v === 'all' || v === 'needs-update' ? undefined : v,
                gap: v === 'needs-update' ? 'needs-update' : undefined,
              }));
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
        {chips.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            {chips.map((c) => (
              <button
                key={c.label}
                type="button"
                onClick={c.clear}
                className="inline-flex items-center gap-1 rounded border border-brand/40 bg-brand/5 px-2 py-0.5 text-fg-secondary transition hover:bg-brand/10"
                aria-label={`Remove filter ${c.label}`}
              >
                {c.label} <span aria-hidden>×</span>
              </button>
            ))}
            {chips.length > 1 && (
              <button
                type="button"
                onClick={() => setFilter({})}
                className="text-fg-subtle hover:text-fg hover:underline"
              >
                Clear all
              </button>
            )}
          </div>
        )}
        <TicketTable
          rows={visible}
          sort={sort}
          onSort={(key) =>
            setSort((s) =>
              s.key === key ? { key, desc: !s.desc } : { key, desc: false },
            )
          }
          expanded={expanded}
          onToggle={(key) =>
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
        />
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

/** Jira's three columns as one bar, by item count — hover a segment for its figures. */
function ColumnBar({ data, total }: { data: SprintWorkBreakdownView; total: number }) {
  if (total === 0) {
    return null;
  }
  const segments = (
    [
      { bucket: 'todo', color: 'bg-fg-faint' },
      { bucket: 'in-progress', color: 'bg-brand' },
      { bucket: 'done', color: 'bg-success' },
    ] as const
  ).filter(({ bucket }) => data.buckets[bucket].items > 0);
  // Not overflow-hidden: that would clip the tooltips. The ends are rounded
  // per segment instead, by position among the non-empty ones.
  return (
    <div className="flex h-3 w-full rounded-full bg-muted">
      {segments.map(({ bucket, color }, i) => {
        const b = data.buckets[bucket];
        const pct = Math.round((b.items / total) * 100);
        return (
          <Tip
            key={bucket}
            className="h-full"
            style={{ width: `${(b.items / total) * 100}%` }}
            content={`${BUCKET_LABEL[bucket]}: ${b.items} of ${total} work items (${pct}%) · ${b.points} pts`}
          >
            <span
              tabIndex={0}
              aria-label={`${BUCKET_LABEL[bucket]}: ${b.items} work items, ${b.points} points`}
              className={cn(
                'metal-bar block h-full w-full transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
                i === 0 && 'rounded-l-full',
                i === segments.length - 1 && 'rounded-r-full',
                color,
              )}
            />
          </Tip>
        );
      })}
    </div>
  );
}

const HEADERS: { key: SortKey; label: string }[] = [
  { key: 'key', label: 'Item' },
  { key: 'default', label: 'Type' },
  { key: 'status', label: 'Jira status' },
  { key: 'points', label: 'Pts' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'default', label: 'Subtasks' },
  { key: 'code', label: 'Code (GitHub)' },
];

function TicketTable({
  rows,
  sort,
  onSort,
  expanded,
  onToggle,
}: {
  rows: SprintTicketRow[];
  sort: { key: SortKey; desc: boolean };
  onSort: (key: SortKey) => void;
  expanded: Set<string>;
  onToggle: (key: string) => void;
}) {
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
            {HEADERS.map((h) => (
              <th
                key={h.label}
                className="py-2 pr-4 font-medium"
                aria-sort={
                  h.key !== 'default' && sort.key === h.key
                    ? sort.desc
                      ? 'descending'
                      : 'ascending'
                    : undefined
                }
              >
                {h.key === 'default' ? (
                  h.label
                ) : (
                  <button
                    type="button"
                    onClick={() => onSort(h.key)}
                    className="inline-flex items-center gap-1 transition hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                  >
                    {h.label}
                    <span aria-hidden className="text-[10px] text-fg-faint">
                      {sort.key === h.key ? (sort.desc ? '▼' : '▲') : '↕'}
                    </span>
                  </button>
                )}
              </th>
            ))}
          </TableHeadRow>
        </thead>
        <tbody>
          {rows.map((t) => {
            const open = expanded.has(t.key);
            return (
              <Fragment key={t.key}>
                <TableBodyRow className={cn(open && 'bg-subtle')}>
                  <td className="py-2.5 pr-4">
                    <button
                      type="button"
                      onClick={() => onToggle(t.key)}
                      aria-expanded={open}
                      aria-controls={`ticket-${t.key}`}
                      className="flex w-full min-w-0 items-baseline gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'shrink-0 text-[10px] text-fg-faint transition-transform duration-150',
                          open && 'rotate-90',
                        )}
                      >
                        ▶
                      </span>
                      <span className="shrink-0 font-medium text-fg-secondary">
                        {t.key}
                      </span>
                      <span className="min-w-0 truncate text-fg-subtle" title={t.title}>
                        {t.title}
                      </span>
                    </button>
                    {t.epicKey && (
                      <div className="pl-4 text-[11px] text-fg-faint">{t.epicKey}</div>
                    )}
                  </td>
                  <td className="py-2.5 pr-4">
                    <TypeBadge type={t.type} />
                  </td>
                  <td className="py-2.5 pr-4">
                    <Badge tone={t.bucket === 'done' ? 'good' : 'neutral'}>
                      {t.status}
                    </Badge>
                  </td>
                  <td className="py-2.5 pr-4 tabular-nums">{t.storyPoints ?? '—'}</td>
                  <td className="truncate py-2.5 pr-4 text-fg-muted">
                    {t.assigneeName ?? '—'}
                  </td>
                  <td className="py-2.5 pr-4 tabular-nums text-fg-muted">
                    {t.subtasks.total > 0
                      ? `${t.subtasks.done}/${t.subtasks.total}`
                      : '—'}
                  </td>
                  <td className="py-2.5">
                    <CodeCell ticket={t} />
                  </td>
                </TableBodyRow>
                {open && (
                  <tr id={`ticket-${t.key}`} className="bg-subtle">
                    <td colSpan={7} className="px-4 pb-3 pt-1">
                      <TicketDetail ticket={t} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
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

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  });

/** The expanded row: everything behind the ticket's summary, and what to do about it. */
function TicketDetail({ ticket }: { ticket: SprintTicketRow }) {
  const { code } = ticket;
  const project = ticket.key.split('-')[0] ?? 'PROJ';
  return (
    <div className="grid gap-4 text-xs sm:grid-cols-3">
      <div>
        <div className="mb-1 font-medium text-fg-muted">Pull requests (GitHub)</div>
        {code.prs.length === 0 ? (
          <p className="text-fg-faint">None linked.</p>
        ) : (
          <ul className="space-y-0.5">
            {code.prs.map((pr) => (
              <li key={pr.ref} className="flex items-center gap-1.5 text-fg-secondary">
                <StatusDot
                  tone={
                    pr.state === 'merged'
                      ? 'good'
                      : pr.state === 'open'
                        ? 'warn'
                        : 'neutral'
                  }
                />
                <span className="truncate">{pr.ref}</span>
                <span className="shrink-0 text-fg-faint">
                  {pr.mergedAt ? `merged ${day(pr.mergedAt)}` : pr.state}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <div className="mb-1 font-medium text-fg-muted">Commits & subtasks</div>
        <p className="text-fg-secondary">
          {code.commits === 0
            ? 'No commits in this sprint name it.'
            : `${code.commits} commit${code.commits === 1 ? '' : 's'} this sprint${
                code.lastCommitAt ? `, last on ${day(code.lastCommitAt)}` : ''
              }.`}
        </p>
        <p className="mt-0.5 text-fg-secondary">
          {ticket.subtasks.total === 0
            ? 'No subtasks in this sprint.'
            : `${ticket.subtasks.done} of ${ticket.subtasks.total} subtasks done.`}
        </p>
        <p className="mt-0.5 text-fg-faint">
          Jira: {ticket.status} · {ticket.storyPoints ?? 'no'} pts ·{' '}
          {ticket.assigneeName ?? 'unassigned'}
        </p>
      </div>
      <div>
        <div className="mb-1 font-medium text-fg-muted">Jira vs GitHub</div>
        {(ticket.gaps ?? []).length === 0 ? (
          <p className="text-fg-faint">Jira matches the GitHub work.</p>
        ) : (
          <ul className="space-y-1">
            {(ticket.gaps ?? []).map((g) => (
              <li key={g}>
                <span
                  className={
                    INFO_GAPS.includes(g)
                      ? 'font-medium text-fg-secondary'
                      : 'font-medium text-warning-fg'
                  }
                >
                  {GAP_COPY[g].title}.
                </span>{' '}
                <span className="text-fg-subtle">{GAP_COPY[g].fix(project)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
