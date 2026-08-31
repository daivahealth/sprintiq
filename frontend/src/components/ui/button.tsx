import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-sm font-semibold tracking-[0.02em] transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 active:scale-[0.98]',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-on-brand hover:bg-brand-muted',
        secondary: 'border border-fg bg-transparent text-fg hover:bg-muted',
        ghost: 'bg-transparent text-brand hover:bg-brand/5',
        destructive: 'bg-danger-solid text-on-danger hover:bg-danger-solid-hover',
      },
      size: {
        sm: 'px-3 py-1.5 text-xs',
        md: 'px-4 py-2 text-sm',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
