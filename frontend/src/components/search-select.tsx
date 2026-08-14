import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { Spinner } from './ui';

/**
 * An option may be a bare string (value doubles as label) or carry its own
 * label and hint — needed where the stored value isn't what a human should
 * read, e.g. a developer identified only by a git email because no GitHub
 * account could be matched to them.
 */
export type SearchSelectOption =
  | string
  | { value: string; label: string; hint?: string };

interface SearchSelectProps {
  label: string;
  value: string | null;
  /** Options for the CURRENT search — server-filtered. */
  options: SearchSelectOption[];
  onSearch: (search: string) => void;
  onSelect: (value: string) => void;
  loading?: boolean;
  placeholder?: string;
  emptyText?: string;
}

function optionValue(option: SearchSelectOption): string {
  return typeof option === 'string' ? option : option.value;
}

function optionLabel(option: SearchSelectOption): string {
  return typeof option === 'string' ? option : option.label;
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
  const selectedLabel =
    options.map(optionLabel).find((_, i) => optionValue(options[i]) === value) ??
    value ??
    '';
  const [query, setQuery] = useState(selectedLabel);
  /**
   * True only once the USER has edited the input since opening it. The input
   * doubles as the selected-value display, so `query` also changes
   * programmatically (auto-select, closing without picking) — and letting
   * those changes reach `onSearch` silently narrowed the server-side catalog
   * to the one selected person: opening the picker listed a single option,
   * and typing appended to the pre-filled label, producing a query like
   * "Animesh-Khatua_athmasan" that matches nothing. Only deliberate edits
   * may drive the search.
   */
  const [dirty, setDirty] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Closing (picked or clicked away): reflect the selected value in the input
  // again, and clear any server-side filter so the next open shows the full
  // list rather than staying pinned to the last search's results.
  useEffect(() => {
    if (!open) {
      setQuery(selectedLabel);
      setDirty(false);
      onSearch('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLabel, open]);

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
  // Gated on `dirty`: programmatic query changes must never fire a search.
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const t = setTimeout(() => onSearch(query), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, dirty]);

  const handleSelect = (option: SearchSelectOption) => {
    onSelect(optionValue(option));
    setQuery(optionLabel(option));
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <span className="mb-1 block text-xs font-medium text-fg-subtle">
        {label}
      </span>
      <div
        className={cn(
          'flex w-64 items-center gap-2 rounded-md border bg-surface px-2 py-1.5',
          open ? 'border-brand ring-2 ring-brand/20' : 'border-border-strong',
        )}
      >
        <input
          value={query}
          onFocus={(e) => {
            setOpen(true);
            // The input arrives pre-filled with the selected value (the board
            // auto-selects a developer on load). Select it so typing REPLACES
            // it, combobox-style — appending to a full login was how a search
            // for "san" became "Animesh-Khatua_athmasan" and matched nothing.
            e.target.select();
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setDirty(true);
            setOpen(true);
          }}
          placeholder={placeholder}
          className="w-full text-sm text-fg outline-none"
        />
        {loading && <Spinner />}
      </div>

      <AnimatePresence>
        {open && (
          <motion.ul
            initial={{ opacity: 0, scale: 0.98, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -4 }}
            transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
            className="absolute z-20 mt-1 max-h-64 w-64 overflow-auto rounded-lg border border-border bg-popover py-1 text-sm shadow-lg"
          >
            {options.map((option) => {
              const v = optionValue(option);
              const hint = typeof option === 'string' ? undefined : option.hint;
              return (
                <li key={v}>
                  <button
                    type="button"
                    onClick={() => handleSelect(option)}
                    className={cn(
                      'block w-full truncate px-3 py-1.5 text-left hover:bg-subtle',
                      v === value && 'bg-brand-fg font-medium text-brand',
                    )}
                  >
                    {optionLabel(option)}
                    {hint && (
                      <span className="ml-1.5 text-xs text-fg-faint">
                        {hint}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
            {options.length === 0 && !loading && (
              <li className="px-3 py-2 text-fg-faint">{emptyText}</li>
            )}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
