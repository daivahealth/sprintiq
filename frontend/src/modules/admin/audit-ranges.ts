/** One push range as `GET .../audit-sync/ranges` lists it. */
export interface AuditRange {
  id: string;
  repoFullName: string;
  ref: string;
  kind: string;
  status: "pending" | "shadowed" | "done" | "failed" | "dismissed";
  attempts: number;
  truncated: boolean;
  commitsFound: number;
  ingested: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
}

/**
 * The ranges an admin should see on Sync Status: failed ones, truncated ones,
 * and pending ones that have already failed at least once (retrying with
 * backoff). A pending range that has never failed is just queued work and is
 * left out; so are finished, complete ranges. Failed first, then truncated,
 * then retrying, newest first within each, with each id shown once.
 */
export function rangesNeedingAttention(ranges: AuditRange[]): AuditRange[] {
  const rank = (r: AuditRange) =>
    r.status === "failed" ? 0 : r.truncated ? 1 : 2;
  const seen = new Set<string>();
  return ranges
    .filter(
      (r) =>
        r.status === "failed" ||
        (r.status === "done" && r.truncated) ||
        (r.status === "pending" && r.attempts > 0),
    )
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .sort(
      (a, b) =>
        rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt),
    );
}
