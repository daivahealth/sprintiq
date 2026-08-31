import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Card,
  Spinner,
  TableBodyRow,
  TableHeadRow,
} from "../../components/ui";
import { api } from "../../lib/api/client";
import { cn } from "../../lib/utils";
import type {
  CollectionProgressResponse,
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

/**
 * The convergence backlog — what is still outstanding and roughly how long it
 * needs. Separate endpoint from sync-status because the backlog is collector
 * state (BC-1) while sync-status is connection state (BC-0).
 */
function useCollectionProgress() {
  return useQuery({
    queryKey: ["admin", "collection-progress"],
    queryFn: () =>
      api.get<CollectionProgressResponse>(
        "/api/admin/configurations/collection-progress",
      ),
    // Slower than the 5s sync-status poll: this is four COUNTs over large
    // tables, and a backlog of thousands does not move perceptibly in 5s.
    refetchInterval: 30_000,
  });
}

/**
 * Queues one connection for the next sweep, ahead of the regular queue.
 *
 * Deliberately a queue rather than an inline sync: a pass is a paginated,
 * rate-limited walk that can take minutes, and the sweep serialises per source
 * so two passes can't fight over the same rate limit. Refetching sync-status
 * immediately is what turns the button into "queued…" — the only feedback
 * available until the sweep actually picks it up.
 */
function useSyncNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      api.post(`/api/admin/connections/${connectionId}/sync-now`, {}),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["admin", "sync-status"] }),
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

function StatCard({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: string | number;
  /** Paints the value in the danger tone — only when the number itself is bad news. */
  danger?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p
        className={cn(
          "text-[28px] font-bold tracking-[-0.045em] tabular-nums",
          danger ? "text-danger-fg" : "text-fg",
        )}
      >
        {value}
      </p>
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
  const syncNow = useSyncNow();
  return (
    <TableBodyRow hoverable={false}>
      <td className="py-2.5 pr-4 font-medium text-fg-secondary">
        {c.name}
        {c.lastError && (
          <span
            className="mt-0.5 block text-xs font-normal text-danger-fg"
            title={c.lastError}
          >
            {c.lastError}
          </span>
        )}
      </td>
      <td className="py-2.5 pr-4 tabular-nums text-fg-muted">
        {c.eventsIngested.toLocaleString()}
      </td>
      <td className="py-2.5 pr-4 text-fg-muted">
        {dateRange(c.earliestEventAt, c.latestEventAt)}
      </td>
      {/* Coverage, not contact — the column that answers "is today's data in?".
          `lastSyncAt` beside it is deliberately kept but demoted: a connection
          can reach the source every 5 minutes while far behind its backfill,
          and showing only that read as freshness it had not earned. */}
      <td className="py-2.5 pr-4 text-fg-muted">
        {c.collectedThroughAt ? (
          timeAgo(c.collectedThroughAt)
        ) : (
          <span className="text-fg-faint">still backfilling</span>
        )}
      </td>
      <td className="py-2.5 pr-4 text-fg-subtle">
        {c.lastSyncAt ? timeAgo(c.lastSyncAt) : "never"}
      </td>
      <td className="py-2.5 pr-4 text-fg-subtle">
        every {formatInterval(c.syncIntervalMinutes)}
      </td>
      <td className="py-2.5 pr-4">
        {/* Failure outranks progress: a connection that can't reach the source
            isn't "backfilling", it's stuck. */}
        {c.lastError ? (
          <Badge tone="bad">failing</Badge>
        ) : isRateLimited ? (
          <Badge tone="warn">rate-limited</Badge>
        ) : c.backfillCompletedAt ? (
          <Badge tone="good">complete</Badge>
        ) : (
          <Badge tone="warn">backfilling</Badge>
        )}
      </td>
      <td className="py-2.5">
        {c.syncRequestedAt ? (
          <span className="text-xs text-fg-faint">queued…</span>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={syncNow.isPending}
            onClick={() => syncNow.mutate(c.id)}
          >
            Sync now
          </Button>
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
        {/* `skipped` is its own outcome, not a zero-event success: the pass
            never reached the source (rate-limit cooldown, missing credential),
            so it is not evidence the connection is up to date. Collapsing it
            into "success" is exactly what let a stalled connection look
            healthy. */}
        {run.status === "success" ? (
          <Badge tone="good">success</Badge>
        ) : run.status === "error" ? (
          <span className="flex items-center gap-1.5">
            <Badge tone="bad">error</Badge>
            {run.errorMessage && (
              <span className="text-xs text-fg-muted">{run.errorMessage}</span>
            )}
          </span>
        ) : run.status === "skipped" ? (
          <span title={run.errorMessage ?? undefined}>
            <Badge tone="neutral">skipped</Badge>
          </span>
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
            <div className="h-2 w-full overflow-hidden rounded-none bg-muted">
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
                  <th className="py-2 pr-4 font-medium">Complete through</th>
                  <th className="py-2 pr-4 font-medium">Last contact</th>
                  <th className="py-2 pr-4 font-medium">Interval</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium">Action</th>
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
                  <th className="py-2 pr-4 font-medium">Complete through</th>
                  <th className="py-2 pr-4 font-medium">Last contact</th>
                  <th className="py-2 pr-4 font-medium">Interval</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium">Action</th>
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

/**
 * "Will this tenant be caught up, and roughly when?"
 *
 * The screen could already say what had *happened* — runs, event counts,
 * badges — but nothing said whether collection was converging, so an admin
 * deciding whether tonight's numbers would be complete had to infer it from
 * log lines. Per-source completeness answers "how far behind is each side"
 * (GitHub backfills far slower than Jira polls, and a blended number hides
 * which one is the problem); the reconciler backlog answers "how much is left".
 *
 * The projection is stated as a floor, not an estimate: the reconcilers stop
 * at a quota reserve and a rate-limited tenant sits idle, so the batch
 * ceilings it derives from can only be beaten by luck, never by less.
 */
function ConvergenceCard({
  sources,
  progress,
}: {
  sources: SourceSyncStatus[];
  progress: CollectionProgressResponse | undefined;
}) {
  const outstanding = progress?.reconcilers.filter((r) => r.remaining > 0) ?? [];

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-fg">Convergence</h3>
        <p className="text-xs text-fg-subtle">
          How complete each source is, and what is still queued to collect.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {sources.map((s) => (
          <div
            key={s.sourceSystem}
            className="rounded-md border border-border bg-subtle p-3"
          >
            <p className="text-xs uppercase tracking-wide text-fg-subtle">
              {sourceLabel(s.sourceSystem)}
            </p>
            {s.collectedThroughAt ? (
              <p className="text-sm font-medium text-fg">
                Complete through {timeAgo(s.collectedThroughAt)}
              </p>
            ) : (
              <p className="text-sm font-medium text-warning-fg">
                {s.incomplete > 0
                  ? `${s.incomplete} connection${s.incomplete === 1 ? "" : "s"} still backfilling`
                  : "Nothing collected yet"}
              </p>
            )}
          </div>
        ))}
      </div>

      {progress && (
        <div className="space-y-2">
          {progress.caughtUp ? (
            <p className="text-sm text-success-fg">
              No outstanding backfill work — every reconciler queue is empty.
            </p>
          ) : (
            <>
              <p className="text-sm text-fg-muted">
                <span className="font-medium text-fg">
                  ~{formatDuration((progress.estimatedMinutesRemaining ?? 0) * 60)}
                </span>{" "}
                until the last queue drains —{" "}
                <span className="text-fg-subtle">
                  best case, since rate-limit pauses only make it longer
                </span>
                .
              </p>
              <ul className="space-y-0.5 text-xs text-fg-subtle">
                {outstanding.map((r) => (
                  <li key={r.key}>
                    {r.label}:{" "}
                    <span className="tabular-nums text-fg-muted">
                      {r.remaining.toLocaleString()}
                    </span>{" "}
                    remaining ({r.ticksRemaining} tick
                    {r.ticksRemaining === 1 ? "" : "s"} at {r.perTick}/tick)
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
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
  const progress = useCollectionProgress();
  const [activeSource, setActiveSource] = useState<string>("github");

  const selected = query.data?.sources.find((s) => s.sourceSystem === activeSource);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-[-0.035em] text-fg">Sync Status</h2>
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Connections" value={query.data.summary.totalConnections} />
            <StatCard label="Backfill complete" value={query.data.summary.backfillComplete} />
            <StatCard label="Backfilling now" value={query.data.summary.backfillInProgress} />
            <StatCard
              label="Failing"
              value={query.data.summary.failing.length}
              danger={query.data.summary.failing.length > 0}
            />
            <StatCard label="Rate-limited" value={query.data.summary.rateLimited} />
            <StatCard
              label="Events ingested"
              value={query.data.summary.totalEventsIngested.toLocaleString()}
            />
          </div>

          <ConvergenceCard
            sources={query.data.sources}
            progress={progress.data}
          />

          {/* Failure outranks everything on this screen — name the stuck
              connections up top instead of making the admin open each source
              tab to find them. */}
          {query.data.summary.failing.length > 0 && (
            <Card className="space-y-1 border-danger">
              <h3 className="text-sm font-semibold text-danger-fg">
                {query.data.summary.failing.length} connection
                {query.data.summary.failing.length === 1 ? "" : "s"} failing
              </h3>
              <ul className="space-y-0.5 text-sm text-fg-muted">
                {query.data.summary.failing.map((f) => (
                  <li key={`${f.sourceSystem}:${f.name}`}>
                    <span className="font-medium text-fg-secondary">
                      {sourceLabel(f.sourceSystem)} · {f.name}
                    </span>{" "}
                    — {f.error}
                    {f.lastErrorAt ? ` (${timeAgo(f.lastErrorAt)})` : ""}
                  </li>
                ))}
              </ul>
            </Card>
          )}

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
