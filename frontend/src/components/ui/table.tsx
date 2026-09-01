import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function TableHeadRow({
  className,
  ...props
}: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b-2 border-rule text-left text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted',
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
