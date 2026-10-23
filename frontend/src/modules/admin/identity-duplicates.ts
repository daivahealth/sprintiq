/** `GET /admin/configurations/identity-overrides/possible-duplicates`. */
export interface DuplicateGroup {
  name: string;
  members: {
    canonicalDeveloperId: string;
    displayName: string;
    sourceKeys: string[];
    hasLogin: boolean;
  }[];
}

/**
 * Which member to suggest as the merge target: the corporate account when one
 * is recognisable (an `_athma`-style org login), else one backed by a GitHub
 * login, else the one with the most identities. A suggestion only — the admin
 * chooses by clicking.
 */
export function suggestedPrimary(group: DuplicateGroup): string {
  const score = (m: DuplicateGroup['members'][number]) =>
    (/_[a-z]+$/i.test(m.canonicalDeveloperId) ? 4 : 0) +
    (m.hasLogin ? 2 : 0) +
    m.sourceKeys.length / 100;
  return [...group.members].sort(
    (a, b) =>
      score(b) - score(a) ||
      a.canonicalDeveloperId.localeCompare(b.canonicalDeveloperId),
  )[0].canonicalDeveloperId;
}
