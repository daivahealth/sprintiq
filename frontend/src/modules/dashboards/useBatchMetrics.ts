import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api/client";
import type { BatchMetricsResponse } from "../../lib/api/types";
import type { Scope } from "../../lib/scope";

/**
 * The scope system's data engine: one request for N metrics × M entities,
 * grouped server-side (DASHBOARDS.md §3/§6). Query key derives from the
 * serialized scope, so caching follows the URL for free.
 */
export function useBatchMetrics(
  metrics: string[],
  scope: Scope,
  from: string,
  groupBy: Scope["groupBy"] = scope.groupBy,
) {
  const params = new URLSearchParams({
    metrics: metrics.join(","),
    groupBy,
    from,
  });
  if (scope.repos.length > 0) params.set("repos", scope.repos.join(","));
  if (scope.projects.length > 0)
    params.set("projects", scope.projects.join(","));

  return useQuery({
    queryKey: ["batch-metrics", metrics.join(","), params.toString()],
    queryFn: () =>
      api.get<BatchMetricsResponse>(`/api/dashboards/metrics?${params}`),
  });
}
