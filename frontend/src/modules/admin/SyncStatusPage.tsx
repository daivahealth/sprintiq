import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  Card,
  Spinner,
  TableBodyRow,
  TableHeadRow,
} from "../../components/ui";
import { api } from "../../lib/api/client";
import { cn } from "../../lib/utils";
import type {
  ConnectionSyncStatus,
  SourceSyncStatus,
  SyncRunHistoryEntry,
  SyncStatusResponse,
} from "../../lib/api/types";
import { timeAgo } from "../../lib/utils";

function useSyncStatus() {
  return useQuery({
    queryKey: ["admin", "sync-status"],
    queryFn: () => api.get<SyncStatusResponse>("/api/admin/connections/sync-status"),
    // Live view — refresh often enough to feel real-time without hammering the API.
    refetchInterval: 5_000,
  });
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function formatInterval(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function dateRange(from: string | null, to: string | null): string {
  if (!from || !to) return "—";
  const fromD = new Date(from);
  const toD = new Date(to);
  const days = Math.max(
    1,
    Math.round((toD.getTime() - fromD.getTime()) / 86_400_000),
  );
  return `${fromD.toLocaleDateString()} → ${toD.toLocaleDateString()} (${days}d)`;
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-2xl font-semibold tracking-[-0.03em] tabular-nums text-fg">{value}</p>
      <p className="text-xs text-fg-subtle">{label}</p>
    </div>
  );
}

function sourceLabel(sourceSystem: string): string {
  if (sourceSystem === "github") return "GitHub";
  if (sourceSystem === "jira") return "Jira";
  return sourceSystem;
}

function ConnectionRow({ c }: { c: ConnectionSyncStatus }) {
  const isRateLimited = Boolean(c.rateLimitedUntil);
  return (
    <TableBodyRow hoverable={false}>
      <td className="py-2.5 pr-4 font-medium text-fg-secondary">{c.name}</td>
      <td className="py-2.5 pr-4 tabular-nums text-fg-muted">
        {c.eventsIngested.toLocaleString()}
      </td>
      <td className="py-2.5 pr-4 text-fg-muted">
        {dateRange(c.earliestEventAt, c.latestEventAt)}
      </td>
      <td className="py-2.5 pr-4 text-fg-subtle">
        {c.lastSyncAt ? timeAgo(c.lastSyncAt) : "never"}
      </td>
      <td className="py-2.5 pr-4 text-fg-subtle">
        every {formatInterval(c.syncIntervalMinutes)}
      </td>
      <td className="py-2.5">
        {isRateLimited ? (
          <Badge tone="warn">rate-limited</Badge>
        ) : c.backfillCompletedAt ? (
          <Badge tone="good">complete</Badge>
        ) : (
          <Badge tone="warn">backfilling</Badge>
        )}
      </td>
    </TableBodyRow>
  );
}

function HistoryRow({ run }: { run: SyncRunHistoryEntry }) {
  const durationMs =
    run.finishedAt && run.startedAt
      ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
      : null;
  return (
    <TableBodyRow hoverable={false}>
      <td className="py-2.5 pr-4 font-medium text-fg-secondary">
        {run.connectionName}
      </td>
      <td className="py-2.5 pr-4 text-fg-subtle">{timeAgo(run.startedAt)}</td>
      <td className="py-2.5 pr-4 text-fg-subtle">
        {durationMs !== null ? `${Math.max(1, Math.round(durationMs / 1000))}s` : "running…"}
      </td>
      <td className="py-2.5 pr-4 tabular-nums text-fg-muted">
        {run.eventsIngested.toLocaleString()}
        {run.eventsFetched > run.eventsIngested
          ? ` / ${run.eventsFetched.toLocaleString()} fetched`
          : ""}
      </td>
      <td className="py-2.5">
        {run.status === "success" ? (
          <Badge tone="good">success</Badge>
        ) : run.status === "error" ? (
          <Badge tone="bad">{run.errorMessage ? `error: ${run.errorMessage}` : "error"}</Badge>
        ) : (
          <Badge tone="warn">running</Badge>
        )}
      </td>
    </TableBodyRow>
  );
}

function SourceSection({ source }: { source: SourceSyncStatus }) {
  const allConnections = [...source.inProgress, ...source.completedRuns];
  const eventsIngested = allConnections.reduce((sum, c) => sum + c.eventsIngested, 0);

  return (
    <Card className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-3">
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs uppercase text-fg-subtle">
          {allConnections.length} connection{allConnections.length === 1 ? "" : "s"}
        </span>
        <span className="text-sm text-fg-subtle">
          {eventsIngested.toLocaleString()} events ingested
        </span>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-fg-secondary">Scheduler</h4>
        {source.tick.running ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge tone="good">running now</Badge>
              <span className="text-sm text-fg-muted">
                {source.tick.connectionsProcessed} of {source.tick.totalConnections}{" "}
                due connections processed this tick
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-brand transition-all"
                style={{
                  width: `${
                    source.tick.totalConnections > 0
                      ? (source.tick.connectionsProcessed / source.tick.totalConnections) * 100
                      : 0
                  }%`,
                }}
              />
            </div>
            <p className="text-xs text-fg-faint">
              {source.tick.etaSeconds !== null
                ? `~${formatDuration(source.tick.etaSeconds)} remaining (rough estimate)`
                : "estimating time remaining…"}
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Badge tone="neutral">idle</Badge>
            <span className="text-sm text-fg-muted">
              {source.tick.finishedAt
                ? `last checked ${timeAgo(source.tick.finishedAt)}`
                : "no tick recorded yet"}
              {" · checks every 5 min; a connection only actually syncs once its own interval has elapsed"}
            </span>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-fg-secondary">
          Backfilling now ({source.inProgress.length})
        </h4>
        {source.inProgress.length === 0 ? (
          <p className="py-3 text-center text-sm text-fg-faint">
            Nothing currently backfilling.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <TableHeadRow>
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Ingested</th>
                  <th className="py-2 pr-4 font-medium">Date coverage</th>
                  <th className="py-2 pr-4 font-medium">Last synced</th>
                  <th className="py-2 pr-4 font-medium">Interval</th>
                  <th className="py-2 font-medium">Status</th>
                </TableHeadRow>
              </thead>
              <tbody>
                {source.inProgress.map((c) => (
                  <ConnectionRow key={c.id} c={c} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-fg-secondary">
          Completed backfills ({source.completedRuns.length})
        </h4>
        {source.completedRuns.length === 0 ? (
          <p className="py-3 text-center text-sm text-fg-faint">
            No backfills have completed yet.
          </p>
        ) : (
          <div className="max-h-72 overflow-y-auto overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface">
                <TableHeadRow>
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Ingested</th>
                  <th className="py-2 pr-4 font-medium">Date coverage</th>
                  <th className="py-2 pr-4 font-medium">Last synced</th>
                  <th className="py-2 pr-4 font-medium">Interval</th>
                  <th className="py-2 font-medium">Status</th>
                </TableHeadRow>
              </thead>
              <tbody>
                {source.completedRuns.map((c) => (
                  <ConnectionRow key={c.id} c={c} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-fg-secondary">
          Recent sync history ({source.history.length})
        </h4>
        <p className="text-xs text-fg-faint">
          Previous sync runs for this source's connections — when it ran, how long it took, and
          what was synced.
        </p>
        {source.history.length === 0 ? (
          <p className="py-3 text-center text-sm text-fg-faint">No sync runs recorded yet.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface">
                <TableHeadRow>
                  <th className="py-2 pr-4 font-medium">Connection</th>
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Duration</th>
                  <th className="py-2 pr-4 font-medium">Synced</th>
                  <th className="py-2 font-medium">Result</th>
                </TableHeadRow>
              </thead>
              <tbody>
                {source.history.map((run) => (
                  <HistoryRow key={run.id} run={run} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

function SourceTabs({
  sources,
  active,
  onSelect,
}: {
  sources: SourceSyncStatus[];
  active: string;
  onSelect: (sourceSystem: string) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-border">
      {sources.map((source) => {
        const connectionCount = source.inProgress.length + source.completedRuns.length;
        const isActive = source.sourceSystem === active;
        return (
          <button
            key={source.sourceSystem}
            type="button"
            onClick={() => onSelect(source.sourceSystem)}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition",
              isActive
                ? "border-brand text-brand"
                : "border-transparent text-fg-subtle hover:text-fg-secondary",
            )}
          >
            {sourceLabel(source.sourceSystem)}
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-fg-subtle">
              {connectionCount}
            </span>
            {source.tick.running && <Badge tone="good">running</Badge>}
          </button>
        );
      })}
    </div>
  );
}

export function SyncStatusPage() {
  const query = useSyncStatus();
  const [activeSource, setActiveSource] = useState<string>("github");

  const selected = query.data?.sources.find((s) => s.sourceSystem === activeSource);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-[-0.02em] text-fg">Sync Status</h2>
        <p className="text-sm text-fg-subtle">
          Data transfer/backfill progress from GitHub and Jira — each source syncs
          independently on its own configurable interval (Configuration screen, default every 4
          hours).
        </p>
      </div>

      {query.isLoading && (
        <Card className="flex items-center gap-2 text-sm text-fg-subtle">
          <Spinner /> Loading…
        </Card>
      )}

      {query.data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Connections" value={query.data.summary.totalConnections} />
            <StatCard label="Backfill complete" value={query.data.summary.backfillComplete} />
            <StatCard label="Backfilling now" value={query.data.summary.backfillInProgress} />
            <StatCard
              label="Events ingested"
              value={query.data.summary.totalEventsIngested.toLocaleString()}
            />
          </div>

          <SourceTabs
            sources={query.data.sources}
            active={activeSource}
            onSelect={setActiveSource}
          />

          {selected && <SourceSection source={selected} />}
        </>
      )}
    </div>
  );
}
