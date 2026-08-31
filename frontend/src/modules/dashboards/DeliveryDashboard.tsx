import { useMemo } from "react";
import { Card, ProvenanceNote } from "../../components/ui";
import { useScope } from "../../lib/scope";
import { timeAgo } from "../../lib/utils";
import { MetricRowsTable, tableTitle } from "./MetricRowsTable";
import { ScopeBar } from "./ScopeBar";
import { useBatchMetrics } from "./useBatchMetrics";
import { ErrorCard, LoadingCard } from "./widgets";

/**
 * Delivery dashboard on the scope system (DASHBOARDS.md): pick any combination
 * of projects × repos × time in the Scope Bar; PR cycle time renders grouped by
 * repo with per-row metric health. Seed of the Repo Explorer (Phase F2).
 */
export function DeliveryDashboard() {
  const { scope, from } = useScope();
  const query = useBatchMetrics(
    ["pr_cycle_time", "loc_added_deleted", "bug_count"],
    scope,
    from,
  );
  // Sorted by changed LOC — EXCEPT when the rows are people. Ranking
  // individuals by lines changed is exactly the leaderboard CLAUDE.md forbids
  // and that Team Capacity is careful to avoid; grouping by developer here made
  // this board one by default. Alphabetical for people, volume for everything
  // else (DASHBOARDS.md §3).
  const groupBy = query.data?.groupBy;
  const rows = useMemo(() => {
    const all = [...(query.data?.rows ?? [])];
    if (groupBy === "developer") {
      return all.sort((a, b) => a.key.localeCompare(b.key));
    }
    return all.sort((a, b) => {
      const changedLoc =
        (b.metrics.loc_added_deleted?.value ?? 0) -
        (a.metrics.loc_added_deleted?.value ?? 0);
      return changedLoc || a.key.localeCompare(b.key);
    });
  }, [query.data?.rows, groupBy]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-[-0.035em] text-fg">Delivery</h2>
        <p className="text-sm text-fg-subtle">
          Flow metrics derived from the correlated delivery graph.
        </p>
      </div>

      <ScopeBar />

      {query.isLoading && <LoadingCard label="Loading metrics…" />}

      {query.isError && (
        <ErrorCard error={query.error} fallback="Failed to load metrics." />
      )}

      {query.data && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-fg">
                {tableTitle(query.data.groupBy)}
              </h3>
              <p className="text-sm text-fg-subtle">
                delivery, change-volume, and bug context · last {scope.days}d ·
                grouped by {query.data.groupBy} ·{" "}
                {groupBy === "developer"
                  ? "merged PRs only · unsorted (activity context, not a ranking)"
                  : "sorted by changed LOC"}
              </p>
            </div>
            <span className="text-xs text-fg-faint">
              {query.data.rows.length} {query.data.groupBy}
              {query.data.rows.length === 1 ? "" : "s"} in scope · computed{" "}
              {timeAgo(query.data.computedAt)}
            </span>
          </div>

          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-fg-faint">
              No repositories in this scope — widen the filters or check
              collector/linkage coverage.
            </p>
          ) : (
            <MetricRowsTable
              rows={rows}
              groupBy={query.data.groupBy}
            />
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
