import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function TableHeadRow({
  className,
  ...props
}: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b border-border text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-faint',
        className,
      )}
      {...props}
    />
  );
}

export function TableBodyRow({
  hoverable = true,
  className,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { hoverable?: boolean }) {
  return (
    <tr
      className={cn(
        'border-b border-border-subtle last:border-0',
        hoverable && 'hover:bg-subtle',
        className,
      )}
      {...props}
    />
  );
}
