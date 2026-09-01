import { cn } from '../../lib/utils';

type StatusDotTone = 'neutral' | 'good' | 'warn' | 'bad';

const TONE_CLASS: Record<StatusDotTone, string> = {
  neutral: 'bg-fg-faint',
  good: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger',
};

export function StatusDot({
  tone = 'neutral',
  size = 'sm',
  className,
}: {
  tone?: StatusDotTone;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-block rounded-none',
        size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2',
        TONE_CLASS[tone],
        className,
      )}
    />
  );
}
