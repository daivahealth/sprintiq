import { Badge, Card, Spinner } from '../../components/ui';
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
    <div className="rounded-lg bg-slate-50 p-4">
      <div className="text-2xl font-semibold text-slate-800">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div>}
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
          <span className="w-44 truncate text-slate-600">{r.label}</span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-slate-100">
            <div
              className={cn('h-full rounded', color)}
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </div>
          <span className="w-24 text-right tabular-nums text-slate-700">
            {r.value}
            {r.secondary && (
              <span className="ml-1 text-xs text-slate-400">{r.secondary}</span>
            )}
          </span>
        </div>
      ))}
      {rows.length === 0 && (
        <p className="py-4 text-center text-sm text-slate-400">No data in scope.</p>
      )}
    </div>
  );
}

export function LoadingCard() {
  return (
    <Card className="flex items-center gap-2 text-sm text-slate-500">
      <Spinner /> Loading…
    </Card>
  );
}

export function ErrorCard({ error }: { error: unknown }) {
  return (
    <Card className="text-sm text-rose-600">
      {(error as ApiError)?.message ?? 'Failed to load.'}
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
      <span className="mb-1 block text-xs font-medium text-slate-500">Sprint</span>
      <select
        value={selected ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-64 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand"
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
      <p className="py-6 text-center text-sm text-slate-400">
        No work items match this scope.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
            <th className="py-2 pr-4 font-medium">Item</th>
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">Pts</th>
            <th className="py-2 pr-4 font-medium">Assignee</th>
            <th className="py-2 pr-4 font-medium">Epic</th>
            <th className="py-2 pr-4 font-medium">Releases</th>
            <th className="py-2 font-medium">Linked PRs (GitHub)</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.key}
              className="border-b border-slate-100 last:border-0 hover:bg-slate-50"
            >
              <td className="max-w-64 py-2.5 pr-4">
                <span className="font-medium text-slate-700">{item.key}</span>
                <span className="ml-2 truncate text-slate-500">{item.title}</span>
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
              <td className="py-2.5 pr-4 text-slate-600">
                {item.assigneeName ?? '—'}
              </td>
              <td className="py-2.5 pr-4 text-slate-600">{item.epicKey ?? '—'}</td>
              <td className="py-2.5 pr-4 text-slate-600">
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
                        className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600"
                      >
                        {pr.ref}
                        {pr.state && (
                          <span
                            className={cn(
                              'h-1.5 w-1.5 rounded-full',
                              pr.state === 'merged'
                                ? 'bg-emerald-500'
                                : pr.state === 'open'
                                  ? 'bg-amber-500'
                                  : 'bg-slate-400',
                            )}
                          />
                        )}
                      </span>
                    ))}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
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
