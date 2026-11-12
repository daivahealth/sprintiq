import { motion } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../../../lib/utils';

/**
 * Sprint Health's metallic primitives (DESIGN-SYSTEM.md "Metallic accents").
 * Scoped to this board on purpose: the rest of the app keeps the flat
 * editorial direction, so these live here rather than in `components/ui`.
 */

/**
 * A brushed-steel stat tile. Becomes a toggle button when `onClick` is given —
 * used to filter the ticket table — and shows its pressed state with a brand
 * ring, never by lifting.
 */
export function MetalStat({
  label,
  value,
  hint,
  active = false,
  onClick,
  title,
  valueClassName,
}: {
  label: string;
  value: string | number;
  hint?: string;
  active?: boolean;
  onClick?: () => void;
  title?: string;
  /** Tone override for the figure, e.g. `text-warning-fg` when it needs attention. */
  valueClassName?: string;
}) {
  const body = (
    <>
      <motion.div
        key={String(value)}
        initial={{ opacity: 0, y: 1 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          'text-[28px] font-bold tracking-[-0.045em] tabular-nums text-fg',
          valueClassName,
        )}
      >
        {value}
      </motion.div>
      <div className="text-xs text-fg-subtle">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] text-fg-faint">{hint}</div>}
    </>
  );
  const shell = cn(
    'metal-surface metal-sheen rounded-lg p-3 text-left',
    onClick &&
      'cursor-pointer transition hover:border-brand/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
    active && 'border-brand ring-2 ring-brand/25',
  );
  if (!onClick) {
    return (
      <div className={shell} title={title}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={shell}
    >
      {body}
    </button>
  );
}

/**
 * Hover/focus tooltip on the popover token. CSS-only (plain `transition`, per
 * the motion rules), and it opens on keyboard focus inside the trigger too.
 */
export function Tip({
  content,
  children,
  className,
  style,
}: {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span className={cn('group/tip relative inline-flex', className)} style={style}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-max max-w-xs -translate-x-1/2 translate-y-1 rounded border border-border bg-popover px-2.5 py-1.5 text-xs text-fg-secondary opacity-0 transition duration-150 group-hover/tip:translate-y-0 group-hover/tip:opacity-100 group-focus-within/tip:translate-y-0 group-focus-within/tip:opacity-100"
      >
        {content}
      </span>
    </span>
  );
}
