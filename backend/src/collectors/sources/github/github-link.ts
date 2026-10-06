/**
 * GitHub pagination helpers shared by every client that must consume a result
 * set completely (audit log, compare). The `rel="next"` URL is returned
 * VERBATIM: GitHub rewrites it (the audit log moves from `/orgs/{login}` to
 * `/organizations/{id}` and adds opaque `after`/`before` cursors), so a URL
 * rebuilt by hand would not be the page GitHub meant.
 */
export function nextLinkUrl(linkHeader: string | null): string | undefined {
  if (!linkHeader) {
    return undefined;
  }
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/** A token is only ever sent to GitHub's own API origin, whatever a Link header says. */
export function isGithubApiUrl(url: string): boolean {
  try {
    return new URL(url).origin === 'https://api.github.com';
  } catch {
    return false;
  }
}

/** For logs: origin + path only. Query strings carry cursors and search phrases. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}
