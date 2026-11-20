import { Search, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { filterList, LIST_PAGE_SIZE, listPage, type ListPage } from './pager';

export interface PagedList<T> extends ListPage<T> {
  setPage: (page: number) => void;
  /** The quick-search text, `''` when not searching. */
  query: string;
  setQuery: (query: string) => void;
  /** Rows before the search narrowed them — `total` is after. */
  unfilteredTotal: number;
}

/**
 * Client-side quick search + paging for the board's lists, `LIST_PAGE_SIZE`
 * (10) rows at a time. `searchText` says what a row is searched by (a name,
 * a ticket key and title); omit it for a list with no search.
 *
 * `resetKey` returns the list to page one, and clears the search, when what
 * it lists changes (another sprint, project selection) — adjusted during
 * render rather than in an effect, same reasoning as `CheckInGrid`'s sprint
 * reset, so a stale page index is never rendered against the new list. A new
 * search also returns to page one: page 3 of the old matches means nothing.
 */
export function usePagedList<T>(
  items: readonly T[],
  resetKey: string,
  searchText?: (item: T) => string,
): PagedList<T> {
  const [page, setPage] = useState(0);
  const [query, setQueryState] = useState('');
  const [trackedKey, setTrackedKey] = useState(resetKey);
  if (resetKey !== trackedKey) {
    setTrackedKey(resetKey);
    setPage(0);
    setQueryState('');
  }
  const setQuery = (next: string) => {
    setQueryState(next);
    setPage(0);
  };
  const matches = searchText ? filterList(items, query, searchText) : items;
  return {
    ...listPage(matches, page, LIST_PAGE_SIZE),
    setPage,
    query,
    setQuery,
    unfilteredTotal: items.length,
  };
}

/**
 * The quick-search box that sits beside a paginated list. Shown only when
 * the list is long enough to page (more than ten rows) — a list that fits on
 * one screen is already searchable by eye.
 */
export function ListSearch({
  paged,
  noun,
  className,
}: {
  paged: PagedList<unknown>;
  /** Plural noun for the placeholder, e.g. "developers". */
  noun: string;
  className?: string;
}) {
  if (paged.unfilteredTotal <= LIST_PAGE_SIZE) {
    return null;
  }
  return (
    <div className={cn('relative w-full sm:w-64', className)}>
      <Search
        aria-hidden
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint"
      />
      <input
        type="search"
        value={paged.query}
        onChange={(e) => paged.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            paged.setQuery('');
          }
        }}
        placeholder={`Search ${noun}…`}
        aria-label={`Search ${noun}`}
        className="w-full rounded-md border border-border-strong bg-surface py-1.5 pl-8 pr-8 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-brand focus:ring-2 focus:ring-brand/20 [&::-webkit-search-cancel-button]:hidden"
      />
      {paged.query && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => paged.setQuery('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-fg-faint hover:text-fg"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * "11–20 of 23 developers · ‹ Prev  Page 2 of 3  Next ›". While searching it
 * says how many of the whole list matched, or that none did. Renders nothing
 * when the whole list fits on one page and no search is narrowing it, so
 * short lists look as they did.
 */
export function ListPager({
  paged,
  noun,
  className,
}: {
  paged: PagedList<unknown>;
  /** Plural noun for the count, e.g. "developers". */
  noun: string;
  className?: string;
}) {
  const searching = paged.query.trim() !== '';
  if (searching && paged.total === 0) {
    return (
      <p className={cn('mt-3 py-2 text-center text-sm text-fg-faint', className)}>
        No {noun} match &ldquo;{paged.query.trim()}&rdquo;.
      </p>
    );
  }
  if (paged.pageCount <= 1 && !searching) {
    return null;
  }
  return (
    <div
      className={cn(
        'mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-fg-subtle',
        className,
      )}
    >
      <span className="tabular-nums">
        {paged.first}–{paged.last} of {paged.total} {noun}
        {searching && ` matching, of ${paged.unfilteredTotal}`}
      </span>
      {paged.pageCount > 1 && (
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            aria-label={`Previous ${noun}`}
            disabled={paged.page <= 0}
            onClick={() => paged.setPage(paged.page - 1)}
          >
            ‹ Prev
          </Button>
          <span className="whitespace-nowrap tabular-nums">
            Page {paged.page + 1} of {paged.pageCount}
          </span>
          <Button
            variant="secondary"
            size="sm"
            aria-label={`Next ${noun}`}
            disabled={paged.page >= paged.pageCount - 1}
            onClick={() => paged.setPage(paged.page + 1)}
          >
            Next ›
          </Button>
        </div>
      )}
    </div>
  );
}
