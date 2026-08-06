import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
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
      <span className="mb-1 block text-xs font-medium text-fg-subtle">
        {label}
      </span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-48 items-center justify-between rounded-md border bg-surface px-3 py-2 text-sm text-fg',
          open ? 'border-brand ring-2 ring-brand/20' : 'border-border-strong',
        )}
      >
        <span className={cn('truncate', selected.length === 0 && 'text-fg-faint')}>
          {selected.length === 0
            ? `All ${label.toLowerCase()}`
            : selected.length === 1
              ? selected[0]
              : `${selected.length} selected`}
        </span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-fg-faint" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -4 }}
            transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
            className="absolute z-20 mt-1 w-72 rounded-lg border border-border bg-popover shadow-lg"
          >
            <div className="flex items-center gap-2 border-b border-border-subtle p-2">
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={placeholder}
                className="w-full rounded-md border border-border px-2 py-1.5 text-sm text-fg outline-none focus:border-brand"
              />
              {loading && <Spinner />}
            </div>

            <ul className="max-h-64 overflow-auto py-1 text-sm">
              {selected.map((value) => (
                <Option key={value} value={value} checked onToggle={toggle} />
              ))}
              {selected.length > 0 && unselected.length > 0 && (
                <li className="my-1 border-t border-border-subtle" />
              )}
              {unselected.map((value) => (
                <Option key={value} value={value} checked={false} onToggle={toggle} />
              ))}
              {selected.length === 0 && options.length === 0 && !loading && (
                <li className="px-3 py-2 text-fg-faint">{emptyText}</li>
              )}
            </ul>

            {selected.length > 0 && (
              <div className="border-t border-border-subtle p-2">
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="text-xs font-medium text-brand hover:underline"
                >
                  Clear selection
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
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
      <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-subtle">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(value)}
          className="h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/30"
        />
        <span className="truncate">{value}</span>
      </label>
    </li>
  );
}
