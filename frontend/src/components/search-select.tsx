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
 * Single-select searchable combobox.
 *
 * The input has ONE job at a time, which is the whole point of the design:
 * closed it displays the selection, open it is an empty search field. It used
 * to do both at once — permanently pre-filled with the selected name — and
 * that overload caused every problem this component has had. The placeholder
 * was dead text nobody could ever see; the box read as a search you had
 * already typed into; and typing appended to a full login, turning a search
 * for "san" into "Animesh-Khatua_athmasan", which matched nothing. That was
 * patched with a select-all-on-focus and a `dirty` flag to keep programmatic
 * writes out of the search — both of which exist only to contain the overload,
 * and both of which go away once the input stops doing two jobs.
 *
 * Opening clears the box so the placeholder shows and the full list is
 * available; the current selection stays visible as the highlighted row rather
 * than as text in the field. Typing debounces into onSearch so the server
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
  const [query, setQuery] = useState('');
  /**
   * The selected option's human label, remembered from whenever it was last
   * resolvable. `options` holds only the CURRENT search's results, so while a
   * filter is active — or in the moment after closing, before the unfiltered
   * refetch lands — the selected option may be absent from it entirely. Without
   * this the closed display would fall back to the raw stored value and show a
   * git login where a name belongs.
   */
  const [selectedLabel, setSelectedLabel] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep the remembered label in step whenever the current value IS resolvable.
  useEffect(() => {
    const match = options.find((o) => optionValue(o) === value);
    if (match) {
      setSelectedLabel(optionLabel(match));
    } else if (!value) {
      setSelectedLabel('');
    }
  }, [options, value]);

  // Opening starts a fresh search; closing clears the server-side filter so the
  // next open sees the full list rather than the last search's results.
  useEffect(() => {
    setQuery('');
    if (!open) {
      onSearch('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
  // Gated on `open` rather than on a `dirty` flag: the box only ever holds a
  // search term while open, so there is no programmatic write left to exclude.
  useEffect(() => {
    if (!open) {
      return;
    }
    const t = setTimeout(() => onSearch(query), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);

  const handleSelect = (option: SearchSelectOption) => {
    onSelect(optionValue(option));
    // Remembered immediately: the unfiltered list has not refetched yet, so
    // resolving this label from `options` on the next render is not reliable.
    setSelectedLabel(optionLabel(option));
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
          // Closed, this shows the selection; open, it is an empty search box.
          // Never both — see the note on the component.
          value={open ? query : selectedLabel}
          onFocus={() => setOpen(true)}
          onChange={(e) => setQuery(e.target.value)}
          // Only meaningful while open, which is exactly when the box is empty.
          placeholder={open ? placeholder : ''}
          aria-expanded={open}
          role="combobox"
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
