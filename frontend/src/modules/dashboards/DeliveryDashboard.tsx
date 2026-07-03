import { Card, Spinner } from "../../components/ui";
import { ApiError } from "../../lib/api/client";
import { useScope } from "../../lib/scope";
import { timeAgo } from "../../lib/utils";
import { MetricRowsTable, tableTitle } from "./MetricRowsTable";
import { ScopeBar } from "./ScopeBar";
import { useBatchMetrics } from "./useBatchMetrics";

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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-800">Delivery</h2>
        <p className="text-sm text-slate-500">
          Flow metrics derived from the correlated delivery graph.
        </p>
      </div>

      <ScopeBar />

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
                {tableTitle(query.data.groupBy)}
              </h3>
              <p className="text-sm text-slate-500">
                delivery, change-volume, and bug context · last {scope.days}d ·
                grouped by {query.data.groupBy}
              </p>
            </div>
            <span className="text-xs text-slate-400">
              {query.data.rows.length} {query.data.groupBy}
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
            <MetricRowsTable
              rows={query.data.rows}
              groupBy={query.data.groupBy}
            />
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
