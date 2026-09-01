import type { ReactNode } from 'react';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-fg-muted">{label}</span>
      {children}
    </label>
  );
}
