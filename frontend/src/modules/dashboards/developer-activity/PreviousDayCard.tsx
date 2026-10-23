import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Badge, Card, ProvenanceNote } from '../../../components/ui';
import { api } from '../../../lib/api/client';
import { timeAgo } from '../../../lib/utils';
import {
  developerDayHref,
  formatReportedDay,
  previousDayHeadline,
  withheldExplanation,
  type PreviousDayView,
} from './previous-day';

function usePreviousDay(day: string | null) {
  return useQuery({
    queryKey: ['watchlist-previous-day', day ?? 'default'],
    queryFn: () =>
      api.get<PreviousDayView>(
        `/api/dashboards/developer-activity/watchlist/previous-day${day ? `?day=${day}` : ''}`,
      ),
    staleTime: 60_000,
  });
}

/**
 * Tracked developers with no delivery signal on one working day — the daily
 * digest's list, in the app for admins (ADR-0009, 2026-10-19 amendment).
 *
 * Mounted only for admins; the API refuses everyone else as well. It shows
 * the rule the list is computed from beside it, as the Teams card must, and
 * reports who could not be evaluated rather than leaving them out silently.
 * When a Teams card was sent for the day, it also says who that card named
 * but who has since shown work — usually a push that landed after the digest.
 */
export function PreviousDayCard() {
  const [day, setDay] = useState<string | null>(null);
  const query = usePreviousDay(day);
  const v = query.data;

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-fg">
            No delivery signal on the previous working day
          </h3>
          <p className="text-xs text-fg-subtle">
            Admins only · the same list the daily Teams digest sends · tracked
            developers only
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-fg-subtle">
          Day
          <input
            type="date"
            className="rounded border border-border bg-surface px-2 py-1 text-xs text-fg"
            value={day ?? v?.day ?? ''}
            max={v?.day && !day ? v.day : undefined}
            onChange={(e) => setDay(e.target.value || null)}
          />
        </label>
      </div>

      {query.isLoading && <p className="text-sm text-fg-faint">Loading…</p>}
      {query.isError && (
        <p className="text-sm text-danger-fg">Could not load this day.</p>
      )}

      {v && (
        <>
          <p className="text-sm text-fg-secondary">{previousDayHeadline(v)}</p>

          {v.withheld && (
            <p className="rounded-md border border-warning-border bg-warning-bg p-2 text-sm text-warning-fg">
              Names are withheld: {withheldExplanation(v.withheld)}.
            </p>
          )}

          {v.flagged.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {v.flagged.map((p) => (
                <Link
                  key={p.developer}
                  to={developerDayHref(p.developer, v.day)}
                  className="rounded bg-muted px-1.5 py-0.5 text-xs text-fg-secondary hover:bg-border"
                >
                  {p.displayName}
                </Link>
              ))}
            </div>
          )}

          {v.namedThenNowActive.length > 0 && (
            <p className="text-xs text-fg-subtle">
              Named on the Teams card for {formatReportedDay(v.day)} but has
              since shown work for that day (pushed after the digest ran):{' '}
              {v.namedThenNowActive.map((p) => p.displayName).join(', ')}.
            </p>
          )}

          {(v.unresolved.length > 0 || v.incomplete.length > 0) && (
            <div className="flex flex-wrap gap-2 text-xs">
              {v.incomplete.length > 0 && (
                <Badge tone="warn">
                  {v.incomplete.length} not evaluated — data for the day is
                  incomplete
                </Badge>
              )}
              {v.unresolved.length > 0 && (
                <Badge tone="neutral">
                  {v.unresolved.length} on the roster with no resolved identity
                </Badge>
              )}
            </div>
          )}

          <ProvenanceNote>
            {v.ruleText} No tracked signal is not the same as no work: pairing,
            design, support and review outside GitHub leave nothing here. A
            prompt to check in, never a verdict.
            {v.lastDigestRun && (
              <>
                {' '}
                Teams digest for this day:{' '}
                {v.lastDigestRun.outcome.replace(/_/g, ' ')}
                {v.lastDigestRun.deliveredAt
                  ? `, ${timeAgo(v.lastDigestRun.deliveredAt)}`
                  : ''}
                .
              </>
            )}
          </ProvenanceNote>
        </>
      )}
    </Card>
  );
}
