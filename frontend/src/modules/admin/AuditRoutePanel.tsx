import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Card,
  TableBodyRow,
  TableHeadRow,
} from "../../components/ui";
import { api } from "../../lib/api/client";
import { timeAgo } from "../../lib/utils";
import { formatLag } from "../dashboards/audit-lag";
import { rangesNeedingAttention, type AuditRange } from "./audit-ranges";

/** `GET /admin/configurations/github/audit-sync/status`. */
interface AuditStatus {
  mode: "off" | "shadow" | "ingest";
  enabled: boolean;
  checkpointAt: string | null;
  lagMinutes: number | null;
  behind: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  pendingRanges: number;
  failedRanges: number;
  truncatedRanges?: number;
  dismissedRanges?: number;
  lastFullSweep: {
    startedAt: string;
    finishedAt: string | null;
    status: string;
  } | null;
}

const BASE = "/api/admin/configurations/github/audit-sync";

function useAuditStatus() {
  return useQuery({
    queryKey: ["admin", "audit-sync", "status"],
    queryFn: () => api.get<AuditStatus>(`${BASE}/status`),
    refetchInterval: 30_000,
  });
}

function useAuditRanges() {
  return useQuery({
    queryKey: ["admin", "audit-sync", "ranges"],
    queryFn: async () => {
      // Two reads rather than one unfiltered list: the ranges an admin acts
      // on are a handful among thousands of finished ones.
      const [failed, pending, done] = await Promise.all([
        api.get<{ ranges: AuditRange[] }>(`${BASE}/ranges?status=failed`),
        api.get<{ ranges: AuditRange[] }>(`${BASE}/ranges?status=pending`),
        api.get<{ ranges: AuditRange[] }>(`${BASE}/ranges?status=done&truncated=true&take=500`),
      ]);
      return rangesNeedingAttention([
        ...failed.ranges,
        ...pending.ranges,
        ...done.ranges,
      ]);
    },
    refetchInterval: 30_000,
  });
}

/**
 * The audit-log route on Sync Status (2026-10-19): whether it is keeping up,
 * and the ranges that need a human — failed, truncated, or retrying.
 *
 * Until this panel the only way to see or clear a stuck range was a database
 * update, and a failed range holds back the daily digest for its day. Retry
 * puts it back in the queue; Dismiss accepts the gap, with a reason that stays
 * on the range and in the audit log.
 */
export function AuditRoutePanel() {
  const status = useAuditStatus();
  const ranges = useAuditRanges();
  const queryClient = useQueryClient();
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["admin", "audit-sync"] });
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`${BASE}/ranges/${id}/retry`, {}),
    onSuccess: refresh,
  });
  const dismiss = useMutation({
    mutationFn: ({ id, why }: { id: string; why: string }) =>
      api.post(`${BASE}/ranges/${id}/dismiss`, { reason: why }),
    onSuccess: () => {
      setDismissing(null);
      setReason("");
      return refresh();
    },
  });
  // Branch history of repos seeded before it was read on first sight
  // (2026-10-26): clears their tips so the next sweep reads every branch.
  const [confirmReread, setConfirmReread] = useState(false);
  const reread = useMutation({
    mutationFn: () =>
      api.post<{ repos: string[]; readOnNextPushOnly: boolean }>(
        `${BASE}/reread-branch-history`,
        {},
      ),
    onSuccess: () => {
      setConfirmReread(false);
      return refresh();
    },
  });

  const s = status.data;
  if (!s) return null;

  const tone = !s.enabled || s.mode === "off"
    ? "neutral"
    : s.failedRanges > 0 || s.behind
      ? "bad"
      : (s.truncatedRanges ?? 0) > 0 || s.pendingRanges > 0
        ? "warn"
        : "good";

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="font-semibold text-fg">Audit-log route</h3>
          <p className="text-xs text-fg-subtle">
            Collects commits on branches with no pull request, from the GitHub
            org audit log plus an hourly branch sweep.
          </p>
        </div>
        <Badge tone={tone}>
          {s.mode === "off"
            ? "off"
            : !s.enabled
              ? `${s.mode} · not configured`
              : s.behind && s.lagMinutes !== null
                ? `${s.mode} · ${formatLag(s.lagMinutes)} behind`
                : `${s.mode} · on time`}
        </Badge>
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        <Fact label="Read through" value={s.checkpointAt ? timeAgo(s.checkpointAt) : "never"} />
        <Fact label="Last run" value={s.lastRunAt ? `${timeAgo(s.lastRunAt)} · ${s.lastStatus ?? "?"}` : "never"} />
        <Fact
          label="Last branch sweep"
          value={s.lastFullSweep ? `${timeAgo(s.lastFullSweep.startedAt)} · ${s.lastFullSweep.status}` : "never"}
        />
        <Fact label="Pending / failed" value={`${s.pendingRanges} / ${s.failedRanges}`} />
        <Fact
          label="Truncated / dismissed"
          value={`${s.truncatedRanges ?? 0} / ${s.dismissedRanges ?? 0}`}
        />
      </dl>

      {s.mode === "ingest" && s.enabled && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
          {confirmReread ? (
            <>
              <span>
                Re-read every branch of every repo on the next branch sweep?
                It costs GitHub API calls and holds back the digest until the
                reads finish.
              </span>
              <Button size="sm" variant="secondary" disabled={reread.isPending} onClick={() => reread.mutate()}>
                Re-read
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmReread(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <span>
                Branches made before a repo was tracked don&apos;t show on
                Developer pages until their history is read.
              </span>
              <Button size="sm" variant="ghost" onClick={() => setConfirmReread(true)}>
                Re-read branch history…
              </Button>
            </>
          )}
          {reread.data && (
            <span className="text-fg-secondary">
              {reread.data.repos.length} repo(s) queued —{" "}
              {reread.data.readOnNextPushOnly
                ? "read on each repo's next push (the branch sweep is off)."
                : "read on the next branch sweep, at :02 past the hour."}
            </span>
          )}
          {reread.isError && (
            <span className="text-danger-fg">{(reread.error as Error).message}</span>
          )}
        </div>
      )}

      {s.lastError && (
        <p className="text-xs text-warning-fg">Last run: {s.lastError}</p>
      )}

      {ranges.data && ranges.data.length > 0 && (
        <div className="overflow-x-auto">
          <p className="mb-1 text-xs text-fg-subtle">
            A failed or truncated range holds back the daily digest for its
            day. Retry it, or dismiss it with a reason to accept the gap.
          </p>
          <table className="w-full text-left text-sm">
            <thead>
              <TableHeadRow>
                <th className="py-2 pr-4 font-medium">Branch</th>
                <th className="py-2 pr-4 font-medium">State</th>
                <th className="py-2 pr-4 font-medium">Attempts</th>
                <th className="py-2 pr-4 font-medium">Last error</th>
                <th className="py-2 font-medium">Action</th>
              </TableHeadRow>
            </thead>
            <tbody>
              {ranges.data.map((r) => (
                <TableBodyRow key={r.id} hoverable={false}>
                  <td className="py-2 pr-4">
                    <div className="text-fg-secondary">{r.repoFullName.replace(/^[^/]+\//, "")}</div>
                    <div className="text-xs text-fg-faint">{r.ref} · {timeAgo(r.createdAt)}</div>
                  </td>
                  <td className="py-2 pr-4">
                    <Badge tone={r.status === "failed" ? "bad" : "warn"}>
                      {r.truncated ? "truncated" : r.status}
                    </Badge>
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{r.attempts}</td>
                  <td className="max-w-xs truncate py-2 pr-4 text-xs text-fg-subtle" title={r.lastError ?? undefined}>
                    {r.lastError ?? (r.truncated ? "more commits than could be read" : "—")}
                  </td>
                  <td className="py-2">
                    {dismissing === r.id ? (
                      <form
                        className="flex items-center gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          dismiss.mutate({ id: r.id, why: reason });
                        }}
                      >
                        <input
                          className="w-40 rounded border border-border bg-surface px-2 py-1 text-xs"
                          placeholder="Why accept the gap?"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          autoFocus
                        />
                        <Button size="sm" variant="destructive" disabled={reason.trim().length < 3 || dismiss.isPending}>
                          Dismiss
                        </Button>
                        <Button size="sm" variant="ghost" type="button" onClick={() => setDismissing(null)}>
                          Cancel
                        </Button>
                      </form>
                    ) : (
                      <div className="flex gap-1">
                        {r.status !== "pending" && (
                          <Button size="sm" variant="secondary" disabled={retry.isPending} onClick={() => retry.mutate(r.id)}>
                            Retry
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setDismissing(r.id)}>
                          Dismiss…
                        </Button>
                      </div>
                    )}
                  </td>
                </TableBodyRow>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-fg-faint">{label}</dt>
      <dd className="text-fg-secondary">{value}</dd>
    </div>
  );
}
