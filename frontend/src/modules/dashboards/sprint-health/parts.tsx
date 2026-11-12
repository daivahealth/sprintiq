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
