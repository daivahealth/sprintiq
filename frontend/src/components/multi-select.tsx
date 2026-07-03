import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { Spinner } from './ui';

interface MultiSelectProps {
  label: string;
  /** Options for the CURRENT search — server-filtered; never the full 200. */
  options: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
  onSearch?: (search: string) => void;
  loading?: boolean;
  placeholder?: string;
  emptyText?: string;
}

/**
 * Searchable multi-select for the scope bar (DASHBOARDS.md §3.1). Async-first:
 * the parent owns option fetching via onSearch (debounced here); selected items
 * stay pinned even when not in the current search results.
 */
export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  onSearch,
  loading,
  placeholder = 'Search…',
  emptyText = 'No matches',
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Debounced server-side search.
  useEffect(() => {
    if (!onSearch) {
      return;
    }
    const t = setTimeout(() => onSearch(search), 250);
    return () => clearTimeout(t);
  }, [search, onSearch]);

  const toggle = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );
  };

  // Pinned selection first, then unselected options from the current search.
  const unselected = options.filter((o) => !selected.includes(o));

  return (
    <div ref={rootRef} className="relative">
      <span className="mb-1 block text-xs font-medium text-slate-500">
        {label}
      </span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-48 items-center justify-between rounded-md border bg-white px-3 py-2 text-sm',
          open ? 'border-brand ring-2 ring-brand/20' : 'border-slate-300',
        )}
      >
        <span className={cn('truncate', selected.length === 0 && 'text-slate-400')}>
          {selected.length === 0
            ? `All ${label.toLowerCase()}`
            : selected.length === 1
              ? selected[0]
              : `${selected.length} selected`}
        </span>
        <svg className="ml-2 h-4 w-4 shrink-0 text-slate-400" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.1l3.71-3.87a.75.75 0 111.08 1.04l-4.25 4.43a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-72 rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center gap-2 border-b border-slate-100 p-2">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={placeholder}
              className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-brand"
            />
            {loading && <Spinner />}
          </div>

          <ul className="max-h-64 overflow-auto py-1 text-sm">
            {selected.map((value) => (
              <Option key={value} value={value} checked onToggle={toggle} />
            ))}
            {selected.length > 0 && unselected.length > 0 && (
              <li className="my-1 border-t border-slate-100" />
            )}
            {unselected.map((value) => (
              <Option key={value} value={value} checked={false} onToggle={toggle} />
            ))}
            {selected.length === 0 && options.length === 0 && !loading && (
              <li className="px-3 py-2 text-slate-400">{emptyText}</li>
            )}
          </ul>

          {selected.length > 0 && (
            <div className="border-t border-slate-100 p-2">
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-xs font-medium text-brand hover:underline"
              >
                Clear selection
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Option({
  value,
  checked,
  onToggle,
}: {
  value: string;
  checked: boolean;
  onToggle: (value: string) => void;
}) {
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-slate-50">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(value)}
          className="h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand/30"
        />
        <span className="truncate">{value}</span>
      </label>
    </li>
  );
}
