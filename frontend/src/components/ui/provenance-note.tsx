import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function ProvenanceNote({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        'border-t border-border-subtle pt-3 text-xs text-fg-subtle',
        className,
      )}
      {...props}
    />
  );
}
