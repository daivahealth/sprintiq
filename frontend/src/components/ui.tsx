import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from 'react';
import { cn } from '../lib/utils';

export function Button({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-md bg-brand px-4 py-2 text-sm font-medium text-white',
        'transition hover:bg-brand-muted disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm',
        'outline-none focus:border-brand focus:ring-2 focus:ring-brand/20',
        className,
      )}
      {...props}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-600">{label}</span>
      {children}
    </label>
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-xl border border-slate-200 bg-white p-5 shadow-sm',
        className,
      )}
      {...props}
    />
  );
}

type BadgeTone = 'neutral' | 'good' | 'warn' | 'bad';

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  const tones: Record<BadgeTone, string> = {
    neutral: 'bg-slate-100 text-slate-600',
    good: 'bg-emerald-100 text-emerald-700',
    warn: 'bg-amber-100 text-amber-700',
    bad: 'bg-rose-100 text-rose-700',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand" />
  );
}
