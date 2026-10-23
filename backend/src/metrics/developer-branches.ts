import { branchKey } from '../modules/code/code.service';

/** One branch a developer committed to, merged or not (branch tracking). */
export interface DeveloperBranch {
  repoFullName: string;
  branch: string;
  commits: number;
  /** Additions + deletions on this branch's commits — volume, not a score. */
  locChanged: number;
  lastCommitAt: string;
  /** From collected PRs by head branch; a label only, never a filter. */
  prStatus: 'merged' | 'open' | 'closed' | 'none';
}

/** Rows returned; `branchesTotal` carries the full count beyond it. */
export const DEVELOPER_BRANCHES_CAP = 50;

/**
 * Groups one developer's commits by the branches they were seen on.
 *
 * A commit on several branches counts on each — that is what "the branches
 * this work has been on" means; nothing here is summed across branches.
 * Ordered by last activity, never by volume (CLAUDE.md "Metrics are
 * ethics-first"), and capped, with the full count returned beside it.
 */
export function developerBranches(
  commits: {
    repoFullName: string;
    sha: string;
    additions: number;
    deletions: number;
    committedAt: Date | null;
    authoredAt: Date;
  }[],
  links: { repoFullName: string; branch: string; sha: string }[],
  prStatus: ReadonlyMap<string, 'merged' | 'open' | 'closed'>,
  cap: number = DEVELOPER_BRANCHES_CAP,
): { branches: DeveloperBranch[]; branchesTotal: number } {
  const bySha = new Map(commits.map((c) => [`${c.repoFullName}@${c.sha}`, c]));
  const acc = new Map<
    string,
    {
      repoFullName: string;
      branch: string;
      commits: number;
      loc: number;
      last: Date;
    }
  >();
  for (const l of links) {
    const c = bySha.get(`${l.repoFullName}@${l.sha}`);
    if (!c) continue;
    const k = branchKey(l.repoFullName, l.branch);
    const at = c.committedAt ?? c.authoredAt;
    const a = acc.get(k) ?? {
      repoFullName: l.repoFullName,
      branch: l.branch,
      commits: 0,
      loc: 0,
      last: at,
    };
    a.commits += 1;
    a.loc += c.additions + c.deletions;
    if (at > a.last) a.last = at;
    acc.set(k, a);
  }
  const all = [...acc.entries()]
    .map(([k, a]) => ({
      repoFullName: a.repoFullName,
      branch: a.branch,
      commits: a.commits,
      locChanged: a.loc,
      lastCommitAt: a.last.toISOString(),
      prStatus: prStatus.get(k) ?? ('none' as const),
    }))
    .sort(
      (x, y) =>
        y.lastCommitAt.localeCompare(x.lastCommitAt) ||
        x.repoFullName.localeCompare(y.repoFullName) ||
        x.branch.localeCompare(y.branch),
    );
  return { branches: all.slice(0, cap), branchesTotal: all.length };
}
