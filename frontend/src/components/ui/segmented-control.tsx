import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function SegmentedControl<T extends string | number>({
  label,
  value,
  options,
  onChange,
  optionClassName,
}: {
  label?: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  optionClassName?: string;
}) {
  return (
    <div>
      {label && (
        <span className="mb-1 block text-xs font-medium text-fg-subtle">
          {label}
        </span>
      )}
      <div className="flex overflow-hidden rounded-md border border-border-strong">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              'px-3 py-2 text-sm transition',
              value === opt.value
                ? 'bg-brand text-on-brand'
                : 'bg-surface text-fg-muted hover:bg-subtle',
              optionClassName,
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
