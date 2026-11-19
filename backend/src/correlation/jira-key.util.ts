/**
 * Jira-key extraction (BC-5). Pulls issue keys like `PAY-2231` from branch
 * names, PR titles, and commit messages. This is the front line of the
 * correlation moat — it produces candidates with provenance so the correlation
 * service can score confidence and surface orphans rather than guess.
 */
export interface JiraKeyMatch {
  key: string; // PAY-2231
  projectKey: string; // PAY
  foundIn: string[]; // which inputs it appeared in (e.g. ['title','branch'])
}

const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+)-(\d+)\b/g;

/**
 * Extract distinct Jira keys across labeled text inputs.
 * @param inputs map of source label → text (e.g. { title, branch, commit })
 */
export function extractJiraKeys(
  inputs: Record<string, string | undefined>,
): JiraKeyMatch[] {
  const byKey = new Map<string, JiraKeyMatch>();

  for (const [label, text] of Object.entries(inputs)) {
    if (!text) {
      continue;
    }
    for (const match of text.matchAll(JIRA_KEY_RE)) {
      const key = match[0];
      const projectKey = match[1];
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.foundIn.includes(label)) {
          existing.foundIn.push(label);
        }
      } else {
        byKey.set(key, { key, projectKey, foundIn: [label] });
      }
    }
  }

  return [...byKey.values()];
}

/**
 * Looser candidates than `JIRA_KEY_RE`, for reads that check every key against
 * a known story before using it (2026-11-19). Two shapes the strict pattern
 * misses, both seen in real branch names and commit messages:
 *   - lowercase or mixed case: `act-92982`, `fix-cihl-1189`, `Namah-10033`;
 *   - an underscore after the number: `ACT-97104_avoid_sending_…` (`\b` treats
 *     `_` as a word character, so the strict pattern finds no boundary there).
 * A number followed by `.digit` is a version (`cms-1.0`), never a key.
 *
 * Lowercase text is full of `utf-8`, `oct-26` and `release-1`, so these are
 * only ever candidates — a caller that cannot resolve them to a story it knows
 * must use `extractJiraKeys` instead. Keys come back upper-cased, distinct.
 */
const LOOSE_JIRA_KEY_RE =
  /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]+)-(\d+)(?![0-9]|\.[0-9])/g;

export function extractJiraKeyCandidates(text: string | undefined): string[] {
  if (!text) return [];
  const keys = new Set<string>();
  for (const m of text.matchAll(LOOSE_JIRA_KEY_RE)) {
    keys.add(`${m[1].toUpperCase()}-${m[2]}`);
  }
  return [...keys];
}
