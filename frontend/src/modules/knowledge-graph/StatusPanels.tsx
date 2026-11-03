import { ChevronDown, Info } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Spinner,
  TableBodyRow,
  TableHeadRow,
} from '../../components/ui';
import { cn, timeAgo } from '../../lib/utils';
import type { KgFreshness, KgStatus } from './api';
import { ENTITY_REGISTRY, type EntityType } from './entity-registry';
import { formatCount, formatDateTime } from './format';
import type { ExplorerReadiness } from './graph-status';
import {
  COVERAGE_STATUS_LABEL,
  type CoverageRow,
  type CoverageStatus,
} from './relationship-coverage';

/** Readiness, history window and build/update times, with node counts. */
export function GraphStatusView({
  readiness,
  status,
  freshness,
}: {
  readiness: ExplorerReadiness;
  status: KgStatus | undefined;
  /** From the latest data response, which may be newer than the status poll. */
  freshness?: KgFreshness;
}) {
  const tone =
    readiness.phase === 'ready'
      ? readiness.stale
        ? 'warn'
        : 'good'
      : readiness.phase === 'initializing' || readiness.phase === 'loading'
        ? 'neutral'
        : 'bad';
  const label: Record<ExplorerReadiness['phase'], string> = {
    loading: 'Checking',
    forbidden: 'Admins only',
    disabled: 'Disabled',
    initializing: 'Initializing',
    failed: 'Build failed',
    error: 'Unavailable',
    ready: readiness.stale ? 'Stale' : 'Ready',
  };
  const builtAt = freshness?.builtAt ?? status?.tenant.builtAt ?? null;
  const lastIncrementalAt =
    freshness?.lastIncrementalAt ?? status?.tenant.lastIncrementalAt ?? null;
  const nodesByType = status?.tenant.nodesByType ?? null;

  return (
    <section aria-label="Graph status" className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-fg-subtle">
        <span className="inline-flex items-center gap-1.5">
          {readiness.phase === 'initializing' || readiness.phase === 'loading' ? (
            <Spinner />
          ) : (
            <Badge tone={tone}>{label[readiness.phase]}</Badge>
          )}
          {readiness.rebuilding && <span>rebuilding in the background</span>}
        </span>
        {status && (
          <>
            <span>
              History window: <strong className="text-fg">{status.windowDays} days</strong>
            </span>
            <span title={formatDateTime(builtAt)}>
              Built: <strong className="text-fg">{builtAt ? timeAgo(builtAt) : '—'}</strong>
            </span>
            <span title={formatDateTime(lastIncrementalAt)}>
              Last update:{' '}
              <strong className="text-fg">
                {lastIncrementalAt ? timeAgo(lastIncrementalAt) : 'none since build'}
              </strong>
            </span>
            <span>Rebuilt every {status.rebuildMinutes} min</span>
            {status.tenant.builtAt && (
              <span>
                {formatCount(status.tenant.totalNodes)} nodes ·{' '}
                {formatCount(status.tenant.totalEdges)} edges
              </span>
            )}
          </>
        )}
      </div>
      {readiness.message && (
        <p
          role={readiness.phase === 'ready' ? 'status' : 'alert'}
          className={cn(
            'text-xs',
            readiness.phase === 'ready' ? 'text-warning-fg' : 'text-fg-muted',
          )}
        >
          {readiness.message}
        </p>
      )}
      {nodesByType && status?.tenant.builtAt && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-faint">
          {(Object.keys(ENTITY_REGISTRY) as EntityType[])
            .filter((type) => ENTITY_REGISTRY[type].available)
            .map((type) => (
              <span key={type}>
                {ENTITY_REGISTRY[type].pluralLabel}: {formatCount(nodesByType[type] ?? 0)}
              </span>
            ))}
        </div>
      )}
    </section>
  );
}

const STATUS_TONE: Record<CoverageStatus, 'good' | 'warn' | 'bad' | 'neutral'> = {
  available: 'good',
  partial: 'warn',
  no_data: 'neutral',
  not_implemented: 'bad',
  planned: 'neutral',
};

const BASIS_LABEL: Record<CoverageRow['basis'], string> = {
  recorded: 'Recorded',
  derived: 'Derived',
  inferred: 'Inferred (confidence-scored)',
  none: '—',
};

/** Which relationships the explorer can show, and why any are missing. */
export function RelationshipCoverageView({
  rows,
  scope,
  defaultOpen = false,
}: {
  rows: CoverageRow[];
  /** What the statuses describe: a repository, or the whole tenant. */
  scope: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const gaps = rows.filter((r) => r.status !== 'available').length;
  return (
    <section aria-label="Relationship coverage" className="border-t border-border pt-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="kg-coverage"
        className="flex w-full items-center justify-between text-left"
      >
        <span className="inline-flex items-center gap-2">
          <Info className="h-4 w-4 text-fg-muted" aria-hidden />
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-fg">
            Relationship coverage
          </span>
          <span className="text-xs text-fg-subtle">
            {scope} · {gaps} of {rows.length} not fully available
          </span>
        </span>
        <ChevronDown
          className={cn('h-4 w-4 text-fg-muted transition', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open && (
        <table id="kg-coverage" className="mt-3 w-full text-left text-sm">
          <thead>
            <TableHeadRow>
              <th className="py-2 pr-3">Relationship</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3">Basis</th>
              <th className="py-2">What it means</th>
            </TableHeadRow>
          </thead>
          <tbody>
            {rows.map((row) => (
              <TableBodyRow key={row.id} hoverable={false} className="align-top">
                <td className="whitespace-nowrap py-2 pr-3 text-fg">
                  {ENTITY_REGISTRY[row.from].label} → {ENTITY_REGISTRY[row.to].label}
                </td>
                <td className="whitespace-nowrap py-2 pr-3">
                  <Badge tone={STATUS_TONE[row.status]}>
                    {COVERAGE_STATUS_LABEL[row.status]}
                  </Badge>
                </td>
                <td className="whitespace-nowrap py-2 pr-3 text-xs text-fg-subtle">
                  {BASIS_LABEL[row.basis]}
                </td>
                <td className="py-2 text-xs text-fg-subtle">{row.explanation}</td>
              </TableBodyRow>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The rule a named-person response was computed under, shown with it. */
export function AttributionRule({ rule }: { rule: string }) {
  return (
    <p className="border-l-2 border-border-strong pl-2 text-xs text-fg-subtle">
      <span className="font-semibold text-fg-muted">Attribution rule. </span>
      {rule}
    </p>
  );
}
