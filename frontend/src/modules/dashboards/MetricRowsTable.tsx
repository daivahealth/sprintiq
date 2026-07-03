import { Badge } from "../../components/ui";
import type { BatchMetricsResponse, MetricRow } from "../../lib/api/types";
import { formatHours } from "../../lib/utils";

type GroupBy = BatchMetricsResponse["groupBy"];

export function MetricRowsTable({
  rows,
  groupBy,
}: {
  rows: MetricRow[];
  groupBy: GroupBy;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
            <th className="py-2 pr-4 font-medium">{groupLabel(groupBy)}</th>
            <th className="py-2 pr-4 font-medium">p50 (median)</th>
            <th className="py-2 pr-4 font-medium">p85</th>
            <th className="py-2 pr-4 font-medium">Merged PRs</th>
            <th className="py-2 pr-4 font-medium">Changed LOC</th>
            <th className="py-2 pr-4 font-medium">Added / Deleted</th>
            <th className="py-2 pr-4 font-medium">Bug Items</th>
            <th className="py-2 font-medium">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cycle = row.metrics.pr_cycle_time;
            const loc = row.metrics.loc_added_deleted;
            const bugs = row.metrics.bug_count;
            return (
              <tr
                key={row.key}
                className="border-b border-slate-100 last:border-0 hover:bg-slate-50"
              >
                <td className="py-2.5 pr-4 font-medium text-slate-700">
                  {row.key}
                </td>
                <td className="py-2.5 pr-4 tabular-nums">
                  {formatHours(cycle?.p50Hours ?? null)}
                </td>
                <td className="py-2.5 pr-4 tabular-nums">
                  {formatHours(cycle?.p85Hours ?? null)}
                </td>
                <td className="py-2.5 pr-4 tabular-nums">
                  {cycle?.sampleSize ?? 0}
                </td>
                <td className="py-2.5 pr-4 tabular-nums">
                  {formatCount(loc?.value)}
                </td>
                <td className="py-2.5 pr-4 tabular-nums">
                  +{formatCount(loc?.additions)} / -
                  {formatCount(loc?.deletions)}
                </td>
                <td className="py-2.5 pr-4 tabular-nums">
                  {groupBy === "developer" ? "N/A" : formatCount(bugs?.value)}
                </td>
                <td className="py-2.5">
                  <ConfidenceBadge sampleSize={cycle?.sampleSize ?? 0} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function tableTitle(groupBy: GroupBy) {
  if (groupBy === "developer") return "Contributor Activity Context";
  if (groupBy === "day") return "Daily Delivery Trend";
  if (groupBy === "project") return "Project Delivery Rollup";
  return "Repository Delivery Rollup";
}

function groupLabel(groupBy: GroupBy) {
  if (groupBy === "developer") return "Contributor";
  if (groupBy === "day") return "Date";
  if (groupBy === "project") return "Project";
  return "Repository";
}

function formatCount(value?: number | null) {
  return typeof value === "number" ? value.toLocaleString() : "0";
}

function ConfidenceBadge({ sampleSize }: { sampleSize: number }) {
  const health: { tone: "bad" | "warn" | "good"; label: string } =
    sampleSize === 0
      ? { tone: "bad", label: "No data" }
      : sampleSize < 5
        ? { tone: "warn", label: "Low confidence" }
        : { tone: "good", label: "Healthy" };
  return <Badge tone={health.tone}>{health.label}</Badge>;
}
