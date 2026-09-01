import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'border-t-2 border-rule bg-surface p-4',
        className,
      )}
      {...props}
    />
  );
}
