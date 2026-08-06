import { useMemo, useState } from "react";
import { Badge, Button, Card, ProvenanceNote } from "../../components/ui";
import { useScope } from "../../lib/scope";
import { timeAgo } from "../../lib/utils";
import { MetricRowsTable } from "./MetricRowsTable";
import { ScopeBar } from "./ScopeBar";
import { useBatchMetrics } from "./useBatchMetrics";
import { useDeveloperCatalog } from "./useInsights";
import { ErrorCard, LoadingCard } from "./widgets";

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
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-[-0.02em] text-fg">Team Capacity</h2>
        <p className="text-sm text-fg-subtle">
          Who has no PR activity in this window — a staffing/blocker signal,
          not a performance ranking.
        </p>
      </div>

      <ScopeBar showGroupBy={false} />

      {(query.isLoading || roster.isLoading) && <LoadingCard />}

      {query.isError && (
        <ErrorCard error={query.error} fallback="Failed to load metrics." />
      )}

      {query.data && roster.data && (
        <Card className="space-y-4">
          <div className="rounded-md border border-border bg-subtle p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-fg-muted">
                <span className="font-medium text-fg">
                  {inactive.length}
                </span>{" "}
                of {roster.data.items.length} known developers had no PR
                activity in the last {scope.days}d.
              </p>
              {inactive.length > 0 && (
                <Button
                  variant="ghost"
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
            <h3 className="font-semibold text-fg">
              Contributor Activity Context
            </h3>
            <p className="text-sm text-fg-subtle">
              {query.data.rows.length} active this window · unsorted — activity
              context, not a ranking
            </p>
          </div>

          {query.data.rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-fg-faint">
              No activity in this scope — widen the filters.
            </p>
          ) : (
            <MetricRowsTable rows={query.data.rows} groupBy="developer" />
          )}

          <ProvenanceNote>
            Source: correlated merged PRs (lineage-traced) · computed{" "}
            {timeAgo(query.data.computedAt)}
          </ProvenanceNote>
        </Card>
      )}
    </div>
  );
}
