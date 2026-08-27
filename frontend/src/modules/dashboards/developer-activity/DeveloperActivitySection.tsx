import { NavLink, Outlet, useSearchParams } from 'react-router-dom';
import { FilterBar } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { FreshnessNote } from '../FreshnessNote';
import { RangeToggle } from './RangeToggle';
import {
  parseRange,
  rangeFrom,
  rangeParams,
  type ActivityRange,
} from './window';

/**
 * Shell for the four Developer Activity subpages (DASHBOARDS.md §4.4).
 *
 * Owns the three things all four share: the title, the tab strip, and the
 * window. Keeping the window here rather than on each page is what makes the
 * tabs feel like one section — switching from Overview to PR Status keeps the
 * range you were reading, and there is exactly one `FreshnessNote` on screen
 * instead of four boards each vouching for their own copy of the same range.
 *
 * The window lives in the URL (`?window=`), like sprint selection does, so a
 * link to a subpage carries the range it was read at (§3, "every granularity
 * queryable").
 */

const TABS = [
  {
    to: 'overview',
    label: 'Overview',
    title: 'Team totals, the daily commit series, and data-health coverage.',
  },
  {
    to: 'watchlist',
    label: 'Watchlist',
    title:
      'Who has shown no tracked signal lately, and who is committing outside the plan.',
  },
  {
    to: 'developer',
    label: 'Developer',
    title: 'One developer’s commits, repos, PRs and assigned work.',
  },
  {
    to: 'pr-status',
    label: 'PR Status',
    title: 'Pull requests waiting on review and how review load is spread.',
  },
];

export function DeveloperActivitySection() {
  const [params, setParams] = useSearchParams();
  const range = parseRange(params);

  const setRange = (next: ActivityRange) => {
    const updated = new URLSearchParams(params);
    for (const [key, value] of rangeParams(next)) {
      updated.set(key, value);
    }
    if (next.kind === 'preset') {
      // Or a stale from/to would ride along in the URL, describing a range
      // nothing on screen is showing.
      updated.delete('from');
      updated.delete('to');
    }
    // `replace` so paging through ranges doesn't bury the previous page under
    // a dozen history entries the reader has to press Back through.
    setParams(updated, { replace: true });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-[-0.02em] text-fg">
          Developer Activity
        </h2>
        <p className="text-sm text-fg-subtle">
          Team activity, the watchlist, one developer’s profile, and the review
          queue. Activity context — never a performance ranking.
        </p>
      </div>

      <div className="border-b border-border">
        <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Developer Activity sections">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={{ pathname: tab.to, search: `?${rangeParams(range)}` }}
              title={tab.title}
              className={({ isActive }) =>
                cn(
                  'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition',
                  isActive
                    ? 'border-brand text-brand'
                    : 'border-transparent text-fg-muted hover:border-border-strong hover:text-fg-secondary',
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>

      <FilterBar>
        <RangeToggle value={range} onChange={setRange} />
        {/* One freshness signal for the whole section. Mounted here rather
            than per page: it judges the window, and the window is the shell's. */}
        <FreshnessNote windowFrom={rangeFrom(range)} />
      </FilterBar>

      <Outlet context={{ range, setRange }} />
    </div>
  );
}
