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
