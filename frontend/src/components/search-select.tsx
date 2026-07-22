import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { Spinner } from './ui';

interface SearchSelectProps {
  label: string;
  value: string | null;
  /** Options for the CURRENT search — server-filtered. */
  options: string[];
  onSearch: (search: string) => void;
  onSelect: (value: string) => void;
  loading?: boolean;
  placeholder?: string;
  emptyText?: string;
}

/**
 * Single-select searchable combobox: one input doubles as the filter box and
 * the selected-value display. Typing debounces into onSearch so the server
 * query fires once per pause, not once per keystroke.
 */
export function SearchSelect({
  label,
  value,
  options,
  onSearch,
  onSelect,
  loading,
  placeholder = 'Search…',
  emptyText = 'No matches',
}: SearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value ?? '');
  const rootRef = useRef<HTMLDivElement>(null);

  // Reflect the selected value in the input once the user isn't actively
  // editing it (e.g. programmatic auto-select, or closing without picking).
  useEffect(() => {
    if (!open) {
      setQuery(value ?? '');
    }
  }, [value, open]);

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

  // Debounced server-side search — fast typing collapses to one request.
  useEffect(() => {
    const t = setTimeout(() => onSearch(query), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const handleSelect = (v: string) => {
    onSelect(v);
    setQuery(v);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <span className="mb-1 block text-xs font-medium text-slate-500">
        {label}
      </span>
      <div
        className={cn(
          'flex w-64 items-center gap-2 rounded-md border bg-white px-2 py-1.5',
          open ? 'border-brand ring-2 ring-brand/20' : 'border-slate-300',
        )}
      >
        <input
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          placeholder={placeholder}
          className="w-full text-sm outline-none"
        />
        {loading && <Spinner />}
      </div>

      {open && (
        <ul className="absolute z-20 mt-1 max-h-64 w-64 overflow-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg">
          {options.map((option) => (
            <li key={option}>
              <button
                type="button"
                onClick={() => handleSelect(option)}
                className={cn(
                  'block w-full truncate px-3 py-1.5 text-left hover:bg-slate-50',
                  option === value && 'bg-brand-fg font-medium text-brand',
                )}
              >
                {option}
              </button>
            </li>
          ))}
          {options.length === 0 && !loading && (
            <li className="px-3 py-2 text-slate-400">{emptyText}</li>
          )}
        </ul>
      )}
    </div>
  );
}
