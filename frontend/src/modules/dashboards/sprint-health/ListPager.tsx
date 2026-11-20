import { useState } from 'react';
import { Button } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { LIST_PAGE_SIZE, listPage, type ListPage } from './pager';

/**
 * Client-side paging for the board's lists, `LIST_PAGE_SIZE` (10) rows at a
 * time. `resetKey` returns the list to page one when what it lists changes
 * (another sprint, project selection) — adjusted during render rather than
 * in an effect, same reasoning as `CheckInGrid`'s sprint reset, so a stale
 * page index is never rendered against the new list.
 */
export function usePagedList<T>(
  items: readonly T[],
  resetKey: string,
): ListPage<T> & { setPage: (page: number) => void } {
  const [page, setPage] = useState(0);
  const [trackedKey, setTrackedKey] = useState(resetKey);
  if (resetKey !== trackedKey) {
    setTrackedKey(resetKey);
    setPage(0);
  }
  return { ...listPage(items, page, LIST_PAGE_SIZE), setPage };
}

/**
 * "11–20 of 23 developers · ‹ Prev  Page 2 of 3  Next ›". Renders nothing
 * when the whole list fits on one page, so short lists look as they did.
 */
export function ListPager({
  paged,
  noun,
  className,
}: {
  paged: ListPage<unknown> & { setPage: (page: number) => void };
  /** Plural noun for the count, e.g. "developers". */
  noun: string;
  className?: string;
}) {
  if (paged.pageCount <= 1) {
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
      </span>
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
    </div>
  );
}
