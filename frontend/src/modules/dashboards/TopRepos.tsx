import { useMemo, useState } from "react";
import { Button, Card, ProvenanceNote } from "../../components/ui";
import { useScope } from "../../lib/scope";
import { timeAgo } from "../../lib/utils";
import { MetricRowsTable } from "./MetricRowsTable";
import { ScopeBar } from "./ScopeBar";
import { useBatchMetrics } from "./useBatchMetrics";
import { ErrorCard, LoadingCard } from "./widgets";

/** Default visible rows before expanding to the full list. */
const DEFAULT_LIMIT = 20;

/**
 * Repositories ranked by change volume — repo-level, not individual, so this
 * doesn't run into the anti-leaderboard rule the way a per-developer sort
 * would (see Team Capacity for why developers stay unsorted/unranked).
 */
export function TopRepos() {
  const { scope, from } = useScope();
  // Always grouped by repo regardless of the shared scope's groupBy — this
  // page has one fixed grouping, so the Group-by toggle is hidden entirely.
  const query = useBatchMetrics(
    ["pr_cycle_time", "loc_added_deleted", "bug_count"],
    scope,
    from,
    "repo",
  );
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    const all = query.data?.rows ?? [];
    const sorted = [...all].sort(
      (a, b) =>
        (b.metrics.loc_added_deleted?.value ?? 0) -
        (a.metrics.loc_added_deleted?.value ?? 0),
    );
    return showAll ? sorted : sorted.slice(0, DEFAULT_LIMIT);
  }, [query.data?.rows, showAll]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-[-0.02em] text-fg">Top Repos</h2>
        <p className="text-sm text-fg-subtle">
          Repositories ranked by commit/LOC volume.
        </p>
      </div>

      <ScopeBar showGroupBy={false} />

      {query.isLoading && <LoadingCard label="Loading metrics…" />}

      {query.isError && (
        <ErrorCard error={query.error} fallback="Failed to load metrics." />
      )}

      {query.data && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-fg">
                Repository Delivery Rollup
              </h3>
              <p className="text-sm text-fg-subtle">
                sorted by changed LOC · last {scope.days}d
              </p>
            </div>
            <span className="text-xs text-fg-faint">
              {query.data.rows.length} repo
              {query.data.rows.length === 1 ? "" : "s"} in scope · computed{" "}
              {timeAgo(query.data.computedAt)}
            </span>
          </div>

          {query.data.rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-fg-faint">
              No repositories in this scope — widen the filters or check
              collector/linkage coverage.
            </p>
          ) : (
            <>
              <p className="text-xs text-fg-faint">
                Showing{" "}
                {showAll
                  ? `all ${rows.length}`
                  : `top ${rows.length} of ${query.data.rows.length}`}
              </p>
              <MetricRowsTable rows={rows} groupBy="repo" />
              {query.data.rows.length > DEFAULT_LIMIT && (
                <Button
                  variant="ghost"
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll
                    ? `Show top ${DEFAULT_LIMIT}`
                    : `Show all ${query.data.rows.length} repos`}
                </Button>
              )}
            </>
          )}

          <ProvenanceNote>
            Source: correlated merged PRs and bug stories (lineage-traced) · LOC
            is change volume/context, not productivity
          </ProvenanceNote>
        </Card>
      )}
    </div>
  );
}
