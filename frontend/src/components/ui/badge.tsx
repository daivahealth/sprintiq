import { cva } from 'class-variance-authority';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

type BadgeTone = 'neutral' | 'good' | 'warn' | 'bad';

const badgeVariants = cva(
  'inline-flex items-center rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em]',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-fg-muted',
        good: 'bg-success-bg text-success-fg',
        warn: 'bg-warning-bg text-warning-fg',
        bad: 'bg-danger-bg text-danger-fg',
      } satisfies Record<BadgeTone, string>,
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({
  tone,
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn(badgeVariants({ tone }), className)}>{children}</span>
  );
}
