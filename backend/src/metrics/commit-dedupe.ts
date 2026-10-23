/**
 * One commit, counted once per person, however many repositories hold it
 * (2026-10-19, METRICS.md §0).
 *
 * A repository created from another's history ("copied repos" — on the
 * reference tenant the three kiosk apps share 1,020 commits, and
 * gateway-app/prrapp 496) holds the very same commit objects, SHA for SHA.
 * Stored per repo, each copy counted again on every people-level figure.
 * Repo- and project-scoped boards keep the per-repo rows, because each
 * repository genuinely contains the commit; figures about a person or the
 * whole team count it once.
 *
 * Not a content match: a cherry-pick or a rebase produces a NEW SHA and is
 * deliberately not collapsed here (work committed on two different branches
 * counts on each, decided 2026-10-19).
 *
 * The copy kept is the one in the alphabetically first repository, so the
 * choice is deterministic whatever order the rows arrive in.
 */
export function distinctCommitsBySha<
  T extends { sha: string; repoFullName: string },
>(commits: T[]): { commits: T[]; sharedCommitsCollapsed: number } {
  const kept = new Map<string, T>();
  for (const c of commits) {
    const cur = kept.get(c.sha);
    if (!cur || c.repoFullName < cur.repoFullName) kept.set(c.sha, c);
  }
  if (kept.size === commits.length) {
    return { commits, sharedCommitsCollapsed: 0 };
  }
  const keep = new Set(kept.values());
  return {
    // Original order preserved: callers rely on newest-first.
    commits: commits.filter((c) => keep.has(c)),
    sharedCommitsCollapsed: commits.length - kept.size,
  };
}
