import { useMemo, useState } from "react";
import { Badge, Button, Card, Spinner } from "../../components/ui";
import { ApiError } from "../../lib/api/client";
import { useScope } from "../../lib/scope";
import { timeAgo } from "../../lib/utils";
import { MetricRowsTable } from "./MetricRowsTable";
import { ScopeBar } from "./ScopeBar";
import { useBatchMetrics } from "./useBatchMetrics";
import { useDeveloperCatalog } from "./useInsights";

/**
 * Capacity signal, not a ranking: developers who show up in zero PRs this
 * window are otherwise invisible (the table only ever lists people with
 * activity) — this surfaces who might need a staffing/blocker check, as a
 * plain alphabetical list, never sorted by any activity metric. The
 * contributor table below is left in its natural (unsorted) order for the
 * same reason — see CLAUDE.md's "no individual leaderboards" rule.
 */
export function TeamCapacity() {
  const { scope, from } = useScope();
  const query = useBatchMetrics(
    ["pr_cycle_time", "loc_added_deleted"],
    scope,
    from,
    "developer",
  );
  const roster = useDeveloperCatalog("");
  const [showNames, setShowNames] = useState(false);

  const inactive = useMemo(() => {
    if (!roster.data) {
      return [];
    }
    const active = new Set((query.data?.rows ?? []).map((r) => r.key));
    return roster.data.items
      .map((d) => d.login)
      .filter((login) => !active.has(login))
      .sort((a, b) => a.localeCompare(b));
  }, [roster.data, query.data?.rows]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-800">Team Capacity</h2>
        <p className="text-sm text-slate-500">
          Who has no PR activity in this window — a staffing/blocker signal,
          not a performance ranking.
        </p>
      </div>

      <ScopeBar showGroupBy={false} />

      {(query.isLoading || roster.isLoading) && (
        <Card className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading…
        </Card>
      )}

      {query.isError && (
        <Card className="text-sm text-rose-600">
          {(query.error as ApiError)?.message ?? "Failed to load metrics."}
        </Card>
      )}

      {query.data && roster.data && (
        <Card className="space-y-4">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-600">
                <span className="font-medium text-slate-800">
                  {inactive.length}
                </span>{" "}
                of {roster.data.items.length} known developers had no PR
                activity in the last {scope.days}d.
              </p>
              {inactive.length > 0 && (
                <Button
                  className="bg-transparent text-brand hover:bg-brand/5"
                  onClick={() => setShowNames((v) => !v)}
                >
                  {showNames ? "Hide" : "Show"} names
                </Button>
              )}
            </div>
            {showNames && inactive.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {inactive.map((login) => (
                  <Badge key={login} tone="warn">
                    {login}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="font-semibold text-slate-800">
              Contributor Activity Context
            </h3>
            <p className="text-sm text-slate-500">
              {query.data.rows.length} active this window · unsorted — activity
              context, not a ranking
            </p>
          </div>

          {query.data.rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">
              No activity in this scope — widen the filters.
            </p>
          ) : (
            <MetricRowsTable rows={query.data.rows} groupBy="developer" />
          )}

          <p className="border-t border-slate-100 pt-3 text-xs text-slate-400">
            Source: correlated merged PRs (lineage-traced) · computed{" "}
            {timeAgo(query.data.computedAt)}
          </p>
        </Card>
      )}
    </div>
  );
}
