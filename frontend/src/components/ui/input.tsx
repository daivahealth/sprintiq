import type { InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-fg',
        'outline-none focus:border-brand focus:ring-2 focus:ring-brand/20',
        'disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}
