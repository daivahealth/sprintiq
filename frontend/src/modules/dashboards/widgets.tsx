import { motion } from 'motion/react';
import {
  Badge,
  Card,
  Spinner,
  StatusDot,
  TableBodyRow,
  TableHeadRow,
} from '../../components/ui';
import { ApiError } from '../../lib/api/client';
import { cn } from '../../lib/utils';
import type { SprintCatalogItem, WorkItemView } from './useInsights';

/** Shared widget shell primitives for the common dashboards. */

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-subtle p-3">
      <motion.div
        // Re-keyed on the value so a changed figure animates in rather than
        // swapping silently: when the range changes, every number on the page
        // changes at once, and a still swap reads as nothing having happened.
        key={String(value)}
        initial={{ opacity: 0, y: 1 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="text-[28px] font-bold tracking-[-0.045em] tabular-nums text-fg"
      >
        {value}
      </motion.div>
      <div className="text-xs text-fg-subtle">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] text-fg-faint">{hint}</div>}
    </div>
  );
}

/** Horizontal CSS bars — dependency-free chart for counts/points per key. */
export function BarList({
  rows,
  color = 'bg-brand',
}: {
  rows: { label: string; value: number; secondary?: string }[];
  color?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3 text-sm">
          <span className="w-44 truncate text-fg-muted">{r.label}</span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
            <div
              className={cn('h-full rounded', color)}
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </div>
          <span className="w-24 text-right tabular-nums text-fg-secondary">
            {r.value}
            {r.secondary && (
              <span className="ml-1 text-xs text-fg-faint">{r.secondary}</span>
            )}
          </span>
        </div>
      ))}
      {rows.length === 0 && (
        <p className="py-4 text-center text-sm text-fg-faint">No data in scope.</p>
      )}
    </div>
  );
}

export function LoadingCard({ label = 'Loading…' }: { label?: string }) {
  return (
    <Card className="flex items-center gap-2 text-sm text-fg-subtle">
      <Spinner /> {label}
    </Card>
  );
}

export function ErrorCard({
  error,
  fallback = 'Failed to load.',
}: {
  error: unknown;
  fallback?: string;
}) {
  return (
    <Card className="text-sm text-danger-fg">
      {(error as ApiError)?.message ?? fallback}
    </Card>
  );
}

export function SprintPicker({
  sprints,
  selected,
  onChange,
}: {
  sprints: SprintCatalogItem[];
  selected: string | null;
  onChange: (externalId: string) => void;
}) {
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-fg-subtle">Sprint</span>
      <select
        value={selected ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-64 rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-brand"
      >
        <option value="" disabled>
          Select a sprint…
        </option>
        {sprints.map((s) => (
          <option key={s.externalId} value={s.externalId}>
            {s.projectKey} · {s.name} ({s.state})
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Work-item detailing table: story/bug/subtask rows with hierarchy, sprint,
 * releases, assignee, and the bi-directional GitHub linkage per item.
 */
export function WorkItemsTable({ items }: { items: WorkItemView[] }) {
  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-fg-faint">
        No work items match this scope.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-[960px] w-full table-fixed text-sm">
        <colgroup>
          <col className="w-[23%]" />
          <col className="w-[7%]" />
          <col className="w-[13%]" />
          <col className="w-[4%]" />
          <col className="w-[12%]" />
          <col className="w-[8%]" />
          <col className="w-[22%]" />
          <col className="w-[11%]" />
        </colgroup>
        <thead>
          <TableHeadRow>
            <th className="py-2 pr-4 font-medium">Item</th>
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">Pts</th>
            <th className="py-2 pr-4 font-medium">Assignee</th>
            <th className="py-2 pr-4 font-medium">Epic</th>
            <th className="py-2 pr-4 font-medium">Releases</th>
            <th className="py-2 font-medium">Linked PRs (GitHub)</th>
          </TableHeadRow>
        </thead>
        <tbody>
          {items.map((item) => (
            <TableBodyRow key={item.key}>
              <td className="py-2.5 pr-4">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-medium text-fg-secondary">
                    {item.key}
                  </span>
                  <span className="min-w-0 truncate text-fg-subtle">
                    {item.title}
                  </span>
                </div>
              </td>
              <td className="py-2.5 pr-4">
                <TypeBadge type={item.type} />
              </td>
              <td className="py-2.5 pr-4">
                <Badge tone={item.done ? 'good' : 'neutral'}>{item.status}</Badge>
              </td>
              <td className="py-2.5 pr-4 tabular-nums">
                {item.storyPoints ?? '—'}
              </td>
              <td className="py-2.5 pr-4 text-fg-muted">
                {item.assigneeName ?? '—'}
              </td>
              <td className="py-2.5 pr-4 text-fg-muted">{item.epicKey ?? '—'}</td>
              <td className="py-2.5 pr-4 text-fg-muted">
                {item.releases.length > 0 ? item.releases.join(', ') : '—'}
              </td>
              <td className="py-2.5">
                {item.linkedPrs.length === 0 ? (
                  <Badge tone="warn">No code linked</Badge>
                ) : (
                  <span className="space-x-2">
                    {item.linkedPrs.map((pr) => (
                      <span
                        key={pr.ref}
                        className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-fg-muted"
                      >
                        {pr.ref}
                        {pr.state && (
                          <StatusDot
                            tone={
                              pr.state === 'merged'
                                ? 'good'
                                : pr.state === 'open'
                                  ? 'warn'
                                  : 'neutral'
                            }
                          />
                        )}
                      </span>
                    ))}
                  </span>
                )}
              </td>
            </TableBodyRow>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Work-item type as a colour-coded badge.
 *
 * Exported because the Developer page's assigned-work table renders the same
 * Jira items as `WorkItemsTable` does; two treatments of one attribute is how
 * the two surfaces start reading as though they disagree.
 *
 * Type is safe to colour by name — the values are a closed set the collector
 * normalizes (story · bug · task · spike · subtask · epic). Status is not, and
 * is deliberately left uncoloured: status *names* are per-project and unbounded
 * ("ACCEPTED IN UAT"), which is why `Story.statusCategory` exists for anything
 * that needs to classify them.
 */
export function TypeBadge({ type }: { type: string }) {
  const tone =
    type === 'bug'
      ? 'bad'
      : type === 'epic'
        ? 'neutral'
        : type === 'subtask'
          ? 'warn'
          : 'good';
  return <Badge tone={tone}>{type}</Badge>;
}
