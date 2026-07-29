import { useMemo, useState } from "react";
import { Button, Card, Spinner } from "../../components/ui";
import { ApiError } from "../../lib/api/client";
import { useScope } from "../../lib/scope";
import { timeAgo } from "../../lib/utils";
import { MetricRowsTable } from "./MetricRowsTable";
import { ScopeBar } from "./ScopeBar";
import { useBatchMetrics } from "./useBatchMetrics";

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
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-800">Top Repos</h2>
        <p className="text-sm text-slate-500">
          Repositories ranked by commit/LOC volume.
        </p>
      </div>

      <ScopeBar showGroupBy={false} />

      {query.isLoading && (
        <Card className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading metrics…
        </Card>
      )}

      {query.isError && (
        <Card className="text-sm text-rose-600">
          {(query.error as ApiError)?.message ?? "Failed to load metrics."}
        </Card>
      )}

      {query.data && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-slate-800">
                Repository Delivery Rollup
              </h3>
              <p className="text-sm text-slate-500">
                sorted by changed LOC · last {scope.days}d
              </p>
            </div>
            <span className="text-xs text-slate-400">
              {query.data.rows.length} repo
              {query.data.rows.length === 1 ? "" : "s"} in scope · computed{" "}
              {timeAgo(query.data.computedAt)}
            </span>
          </div>

          {query.data.rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">
              No repositories in this scope — widen the filters or check
              collector/linkage coverage.
            </p>
          ) : (
            <>
              <p className="text-xs text-slate-400">
                Showing{" "}
                {showAll
                  ? `all ${rows.length}`
                  : `top ${rows.length} of ${query.data.rows.length}`}
              </p>
              <MetricRowsTable rows={rows} groupBy="repo" />
              {query.data.rows.length > DEFAULT_LIMIT && (
                <Button
                  className="bg-transparent text-brand hover:bg-brand/5"
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll
                    ? `Show top ${DEFAULT_LIMIT}`
                    : `Show all ${query.data.rows.length} repos`}
                </Button>
              )}
            </>
          )}

          <p className="border-t border-slate-100 pt-3 text-xs text-slate-400">
            Source: correlated merged PRs and bug stories (lineage-traced) · LOC
            is change volume/context, not productivity
          </p>
        </Card>
      )}
    </div>
  );
}
