import { GitPushAuditEvent } from './github-audit-log.client';

/**
 * Pure planning for the audit-log route (spec §4.3). No I/O.
 *
 * `git.push` audit events name the repo but not the ref or SHAs, so the plan
 * comes from diffing branch tips: the tip stored last run against the tip now.
 * That diff IS the consolidated range the brief asks for — however many pushes
 * moved `feature-A` from A to D between runs, it costs one Compare A...D — and
 * unrelated branches can never be merged into one range, because each ref is
 * diffed only against itself.
 */
export type RangeKind = 'moved' | 'new_ref' | 'deleted';

export interface PlannedRange {
  repoFullName: string;
  ref: string;
  baseSha?: string;
  /** Set for `new_ref`: compare against this branch NAME (the default branch). */
  baseRef?: string;
  headSha?: string;
  kind: RangeKind;
}

export interface TipDiff {
  ranges: PlannedRange[];
  upserts: Array<{ ref: string; sha: string }>;
  deletes: string[];
}

/** `GithubRefTip.ref` of the row caching a repo's default branch; its `sha` column holds the branch NAME. */
export const DEFAULT_BRANCH_MARKER = 'HEAD';

export function dedupePushes(events: GitPushAuditEvent[]): GitPushAuditEvent[] {
  const byId = new Map<string, GitPushAuditEvent>();
  for (const e of events) {
    if (!byId.has(e.documentId)) byId.set(e.documentId, e);
  }
  return [...byId.values()];
}

export function pushesByRepo(
  events: GitPushAuditEvent[],
): Map<string, GitPushAuditEvent[]> {
  const groups = new Map<string, GitPushAuditEvent[]>();
  for (const e of events) {
    const list = groups.get(e.repoFullName) ?? [];
    list.push(e);
    groups.set(e.repoFullName, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
  return groups;
}

export function diffTips(
  repoFullName: string,
  stored: Map<string, string>,
  current: Map<string, string>,
  defaultBranch: string,
): TipDiff {
  const ranges: PlannedRange[] = [];
  const upserts: Array<{ ref: string; sha: string }> = [];
  const deletes: string[] = [];

  for (const [ref, sha] of current) {
    const before = stored.get(ref);
    if (before === sha) continue;
    upserts.push({ ref, sha });
    if (before) {
      // Fast-forward or force-push alike: Compare returns what `sha` has that
      // `before` lacks, which on a diverged history is exactly the new work.
      ranges.push({
        repoFullName,
        ref,
        baseSha: before,
        headSha: sha,
        kind: 'moved',
      });
    } else if (ref !== defaultBranch) {
      // A ref we have never seen (the "before = 0000…" push): its new work is
      // whatever it carries that the default branch does not.
      ranges.push({
        repoFullName,
        ref,
        baseRef: defaultBranch,
        headSha: sha,
        kind: 'new_ref',
      });
    }
  }
  for (const [ref, sha] of stored) {
    if (!current.has(ref)) {
      // The "after = 0000…" push. Nothing to fetch: its commits were collected
      // when the tip was last seen, or were never observable (spec §10).
      deletes.push(ref);
      ranges.push({ repoFullName, ref, baseSha: sha, kind: 'deleted' });
    }
  }
  return { ranges, upserts, deletes };
}

export function countRanges(ranges: PlannedRange[]) {
  return {
    compareRequestsPlanned: ranges.filter((r) => r.kind !== 'deleted').length,
    refsMoved: ranges.filter((r) => r.kind === 'moved').length,
    refsNew: ranges.filter((r) => r.kind === 'new_ref').length,
    refsDeleted: ranges.filter((r) => r.kind === 'deleted').length,
  };
}
