import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { initials } from './presentation';

/**
 * Section heading for the Sprint Health board: the title on the left and,
 * on the right, a quiet "echo" saying what the section is counting — the
 * scope a reader would otherwise have to infer from the numbers.
 */
export function SectionTitle({
  title,
  echo,
  className,
}: {
  title: string;
  echo?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1',
        className,
      )}
    >
      <h3 className="text-sm font-semibold text-fg-muted">{title}</h3>
      {echo && <span className="text-xs text-fg-faint">{echo}</span>}
    </div>
  );
}

/**
 * The board's container, as in the "Team & Code Activity" mockup: a flat,
 * bordered, rounded panel on the surface token — no gradient, no shadow.
 * Every block of content on the board sits in one (filters, check-in grid,
 * contributor table, quality cards, RC cards).
 */
export function Panel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-surface px-5 py-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A flat metric tile (the mockup's `.metric-card`): figure, label, and an
 * optional quieter sub-line. Replaced the metallic `MetalStat` on this board
 * (2026-11-12).
 */
export function Tile({
  label,
  value,
  hint,
  valueClassName,
}: {
  label: string;
  value: string | number;
  hint?: string;
  /** Tone override for the figure, e.g. `text-warning-fg` when it needs attention. */
  valueClassName?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3.5">
      <div
        className={cn(
          'text-2xl font-bold tracking-[-0.02em] tabular-nums text-fg',
          valueClassName,
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[12.5px] text-fg-muted">{label}</div>
      {hint && <div className="mt-1.5 text-[11px] text-fg-faint">{hint}</div>}
    </div>
  );
}

/** Initials avatar + display name, as a table cell's content. */
export function DevName({ name }: { name: string }) {
  return (
    <span className="flex items-center gap-2.5 font-semibold text-fg-secondary">
      <span
        aria-hidden
        className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-brand/15 text-[10px] font-bold text-brand"
      >
        {initials(name)}
      </span>
      <span className="truncate">{name}</span>
    </span>
  );
}
