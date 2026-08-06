import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function FilterBar({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4',
        className,
      )}
      {...props}
    />
  );
}
