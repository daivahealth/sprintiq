import { Prisma } from '@prisma/client';

/**
 * Identity-matching primitives for BC-5 developer identity resolution.
 *
 * Pure functions, no I/O — the matching rules are the part that decides whose
 * work a commit counts as, so they are kept separately testable from the
 * service that applies them.
 */

/** One observed source identity: what a commit or PR told us about its author. */
export interface SourceIdentity {
  /** Login the source resolved, when it resolved one. */
  login?: string | null;
  email?: string | null;
  name?: string | null;
}

/**
 * A Jira assignee as `planning_story` records one: an account reference and a
 * display name, never an email.
 *
 * Kept as its own type rather than reusing `SourceIdentity` because the `login`
 * here means something categorically different. A GitHub login IS the canonical
 * developer id — rung 1 of `resolveIdentity` returns it directly. A Jira
 * `assigneeLogin` is an account reference in a different namespace (an opaque
 * `accountId` on Jira Cloud), so treating it the same way would mint a second
 * canonical developer for every person who has both accounts — the exact split
 * this service exists to heal.
 */
export interface JiraAssigneeIdentity {
  /** Jira's account reference — `accountId` on Cloud, username on Server. */
  login?: string | null;
  /** Display name — the fallback rung when no email is disclosed. */
  name?: string | null;
  /**
   * The Atlassian account email, where Jira disclosed it. Usually the same
   * corporate address the person commits under, which makes it the one piece
   * of evidence here strong enough to match on rather than infer from.
   */
  email?: string | null;
}

export type IdentityMethod =
  'github_login' | 'email_exact' | 'name_normalized' | 'unresolved';

export interface IdentityMatch {
  canonicalDeveloperId: string;
  confidence: number;
  method: IdentityMethod;
  /** Why this link was made — persisted so any attribution can be explained. */
  evidence: Prisma.InputJsonValue;
}

/**
 * Confidence per method. `github_login` is the source's own answer, so it is
 * certain. `email_exact` reuses a mapping GitHub itself verified, on a key that
 * is unique per person. `name_normalized` is an inference — high enough to
 * attribute on, deliberately below the two facts above so it is visibly a
 * judgement, and only ever applied to an unambiguous match.
 */
export const IDENTITY_CONFIDENCE: Record<IdentityMethod, number> = {
  github_login: 1,
  email_exact: 0.95,
  name_normalized: 0.8,
  unresolved: 0,
};

/** Stable key for an observed identity — login when known, else email. */
export function sourceKeyOf(identity: SourceIdentity): string | null {
  if (identity.login) {
    return `login:${identity.login}`;
  }
  if (identity.email) {
    return `email:${identity.email.toLowerCase()}`;
  }
  // A commit with neither is unattributable by construction; nothing to key on.
  return null;
}

/**
 * Collapses a display name or login to a comparison key.
 *
 * Two normalizations, both load-bearing on real data:
 *
 * 1. **Drop a trailing `_suffix`.** GitHub Enterprise Managed User logins are
 *    `<name>_<enterprise-shortcode>` (e.g. `Sangeetha-S_athma`), a shape no git
 *    `user.name` ever carries. Without stripping it, no EMU login can ever
 *    match the name its owner commits under.
 * 2. **Drop every non-alphanumeric.** The same human is `Sangeetha-S` in a
 *    login, `sangeethas` in one repo's git config and `Sangeetha S` in
 *    another's; separators carry no identity.
 *
 * Deliberately NOT fuzzy: no edit distance, no token subsets, no initials
 * expansion. Those turn distinct colleagues into each other, and attributing
 * one person's commits to another is a worse failure than leaving them
 * unattributed. Anything this doesn't match stays honestly unresolved.
 */
export function normalizeIdentityKey(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  return value
    .replace(/_[^_]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Every name a canonical developer is known by, across both systems. */
export interface DisplayNameSources {
  canonicalDeveloperId: string;
  /** Jira's human-curated display name — the best source when it exists. */
  jiraDisplayName?: string | null;
  /** GitHub login, EMU shortcode and all. */
  githubLogin?: string | null;
  /** `git user.name`, which is whatever the person typed into a config file. */
  gitName?: string | null;
}

/**
 * A GitHub login rendered as a human name: `Ram-Kumar_athma` → "Ram Kumar".
 *
 * Same trailing-`_shortcode` strip as `normalizeIdentityKey`, for the same
 * reason (EMU logins are `<name>_<enterprise>`), then separators become spaces.
 * Unlike that function this keeps case and word boundaries, because the output
 * is read by a person rather than compared.
 */
export function loginToDisplayName(login: string): string {
  return login
    .replace(/_[^_]+$/, '')
    .replace(/[-._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One name per developer, so the same human stops appearing as
 * `Ram-Kumar_athma` on one screen and `RamKumar AK` on another.
 *
 * The ladder is ordered by how curated each source is, measured on the
 * reference tenant across 89 linked developers:
 *
 *   1. **Jira display name** — human-entered in the system that tracks people;
 *      complete for every linked developer, and correctly spaced
 *      ("Gnanesh Gowda NS", "Pavan Kumar Reddy Gaddam").
 *   2. **GitHub login, de-EMU'd** — equally clean where present, but 14 of 111
 *      GitHub entities have no login at all.
 *   3. **git author name** — whatever was in a config file, so it ranges from a
 *      proper name to `animesh.khatua` to the login itself (`Jana-M_athma`).
 *   4. the canonical id, which is always something.
 *
 * Deliberately NOT derived from the org email, despite that being the identity
 * spine: local parts mangle the name. `vijaykumar.yadav01@` gives "Vijaykumar
 * Yadav01" and `sivaganeshsagar.yedumalla@` gives "Sivaganeshsagar" — digits
 * and lost word boundaries. An email is a good key and a poor label.
 */
export function resolveDisplayName(sources: DisplayNameSources): string {
  const jira = tidyName(sources.jiraDisplayName);
  if (jira) {
    return jira;
  }
  const login = sources.githubLogin?.trim();
  if (login) {
    const rendered = tidyName(loginToDisplayName(login));
    if (rendered) {
      return rendered;
    }
  }
  const gitName = sources.gitName?.trim();
  if (gitName) {
    // A git `user.name` is frequently the login verbatim — real data carries
    // `saravanakumar_athma` and `Jana-M_athma` in this field. Rendering it raw
    // put an EMU shortcode on screen as though it were someone's name, so it
    // goes through the same treatment as a login when it looks like one.
    const rendered = tidyName(
      /_[^_\s]+$/.test(gitName) ? loginToDisplayName(gitName) : gitName,
    );
    if (rendered) {
      return rendered;
    }
  }
  return sources.canonicalDeveloperId;
}

/**
 * Trims trailing separator punctuation from a name.
 *
 * Jira display names are hand-entered and some carry a dangling initial —
 * "Shivam ." rendered exactly like that. Deliberately only TRAILING, and only
 * separators: an interior dot is a real initial ("Rohit S. Patwardhan") and
 * stripping it would damage the name it is trying to tidy.
 */
function tidyName(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/[\s.,;:_-]+$/, '')
    .trim();
}

/** A possible identity match, for a human to confirm — never applied. */
export interface MatchSuggestion {
  /** The candidate's identifier (Jira assignee ref, or canonical developer). */
  candidate: string;
  /** What to show. */
  candidateName: string;
  /** `token_subset` (stronger) or `substring`. */
  basis: 'token_subset' | 'substring';
}

/** Words of a name, lowercased, punctuation dropped. */
function tokensOf(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Names that might be the same person — ranked, capped, and never applied.
 *
 * Two signals, both requiring **containment** rather than mere overlap. That
 * distinction is the whole safety argument:
 *
 *   `Junaid Haneef` vs `Mohammed Junaid Haneef` → {junaid,haneef} ⊂ {mohammed,junaid,haneef} ✓
 *   `Vijay Kumar Yadav` vs `Sanjay Kumar Yadav` → shares {kumar,yadav}, but neither
 *      contains the other, so it is REJECTED.
 *
 * Plain overlap scores those two cases identically at 2/3, which is exactly how
 * one colleague's work gets credited to another. Containment separates them.
 *
 * The substring rung catches the compacted forms token comparison misses
 * (`Ram Kumar` vs `RamKumar AK` — "ramkumar" inside "ramkumarak"), floored at
 * `MIN_SUBSTRING_KEY` characters so short names can't match half the roster.
 *
 * Returning SEVERAL candidates is deliberate: where more than one name fits,
 * showing all of them is what stops a reader treating a coin flip as an answer.
 */
const MIN_SUBSTRING_KEY = 5;

export function suggestMatches(
  name: string | null | undefined,
  candidates: { id: string; name: string }[],
  limit = 3,
): MatchSuggestion[] {
  if (!name) {
    return [];
  }
  const tokens = new Set(tokensOf(name));
  const key = normalizeIdentityKey(name);
  if (tokens.size === 0 || !key) {
    return [];
  }

  const out: MatchSuggestion[] = [];
  for (const candidate of candidates) {
    const candTokens = new Set(tokensOf(candidate.name));
    const candKey = normalizeIdentityKey(candidate.name);
    if (candTokens.size === 0 || !candKey || candKey === key) {
      continue;
    }

    const subset =
      [...tokens].every((t) => candTokens.has(t)) ||
      [...candTokens].every((t) => tokens.has(t));
    if (subset) {
      out.push({
        candidate: candidate.id,
        candidateName: candidate.name,
        basis: 'token_subset',
      });
      continue;
    }

    const shorter = key.length <= candKey.length ? key : candKey;
    const longer = shorter === key ? candKey : key;
    if (shorter.length >= MIN_SUBSTRING_KEY && longer.includes(shorter)) {
      out.push({
        candidate: candidate.id,
        candidateName: candidate.name,
        basis: 'substring',
      });
    }
  }

  // Token subsets first — they are evidence about words, not about characters.
  return out
    .sort((a, b) =>
      a.basis === b.basis ? 0 : a.basis === 'token_subset' ? -1 : 1,
    )
    .slice(0, limit);
}

/**
 * Automation accounts GitHub does not mark for us on the commit path.
 *
 * `PrReview.isBot` is recorded at collection time from GitHub's own
 * `user.type == "Bot"`, but commits carry no equivalent flag, so a developer
 * roll-up derived from commit authorship has to fall back to the same
 * `name[bot]` login convention `PrReview` uses as *its* fallback, plus the
 * handful of first-party accounts that don't follow it (`Copilot` is a bare
 * login; `dependabot` appears both bare and suffixed).
 *
 * Matching on the login rather than the email because this is asked of a
 * canonical developer id, which is a login wherever one is known.
 */
const BOT_LOGIN_SUFFIX = /\[bot\]$/i;
const KNOWN_BOT_LOGINS = new Set([
  'copilot',
  'dependabot',
  'dependabot-preview',
  'github-actions',
  'renovate',
  'snyk-bot',
  'imgbot',
]);

/**
 * The shape GitHub leaves behind when an Enterprise Managed User is
 * deprovisioned: the human-readable login is replaced by a long hex string,
 * keeping the enterprise shortcode. On the reference tenant,
 * `1a824967e10493200d5a7ee2d91b87_athma` — 83 pull requests, no name.
 *
 * Deliberately narrow. 20+ characters of *pure* hex is not a name anyone
 * chose, whereas a shorter or mixed string might be (`deadbeef` is a real
 * login somewhere). Erring toward leaving a real person in the roster is the
 * right direction: the cost of a false negative is one odd-looking row, and
 * the cost of a false positive is quietly removing someone from a board whose
 * whole purpose is noticing people.
 */
const ANONYMIZED_LOGIN = /^[0-9a-f]{20,}$/i;

export function isAnonymizedAccount(
  canonicalDeveloperId: string | null | undefined,
): boolean {
  if (!canonicalDeveloperId) {
    return false;
  }
  // Strip the enterprise shortcode the same way the display path does, so
  // `<hash>_athma` and a bare `<hash>` are both recognised.
  return ANONYMIZED_LOGIN.test(canonicalDeveloperId.replace(/_[^_]+$/, ''));
}

/**
 * Whether a canonical developer id is automation rather than a person.
 *
 * Used to keep bots out of any figure that counts *people*: they are not
 * developers who might need a Jira account, and they are not colleagues anyone
 * should be prompted to go check on. Their commits still count in commit and
 * LOC totals — this excludes them from head-counts, not from the work.
 */
export function isBotDeveloper(
  canonicalDeveloperId: string | null | undefined,
): boolean {
  if (!canonicalDeveloperId) {
    return false;
  }
  const id = canonicalDeveloperId.toLowerCase();
  return BOT_LOGIN_SUFFIX.test(id) || KNOWN_BOT_LOGINS.has(id);
}

/**
 * Emails that identify a platform rather than a person. `noreply` addresses are
 * GitHub's own privacy proxy: `<id>+<login>@users.noreply.github.com` encodes
 * the login (so it resolves anyway, via the login) but a bare
 * `noreply@github.com` on a web-UI commit belongs to no one, and treating it as
 * one person's email would merge every such commit into a single phantom
 * developer.
 */
export function isMachineEmail(email: string | null | undefined): boolean {
  if (!email) {
    return false;
  }
  const lower = email.toLowerCase();
  return (
    lower === 'noreply@github.com' ||
    lower.endsWith('@users.noreply.github.com') ||
    lower.startsWith('action@github.com') ||
    lower.includes('[bot]')
  );
}

/**
 * Inverts a set of identities into normalized-key → logins.
 *
 * Values are arrays, never a single login, because a collision has to stay
 * visible: two different colleagues can normalize to the same key, and the
 * caller must be able to see that and refuse rather than pick one.
 */
export function indexLoginsByNormalizedKey(
  logins: Iterable<string>,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const login of logins) {
    const key = normalizeIdentityKey(login);
    if (!key) {
      continue;
    }
    const existing = index.get(key) ?? [];
    if (!existing.includes(login)) {
      index.set(key, [...existing, login]);
    }
  }
  return index;
}

/**
 * lowercased email → canonical developer, for the Jira bridge's strong rung.
 *
 * Built from identities GitHub already resolved, NOT from raw commit rows, so
 * an address recovered by the GitHub pass counts too: a person committing as
 * `357486@corp.example` whose git name matched their login is reachable here
 * under that numeric address, and their Atlassian email will match it if the
 * two agree.
 *
 * Two exclusions, both load-bearing:
 *  - **machine addresses** identify a platform, not a human;
 *  - **an address seen under more than one canonical developer** identifies no
 *    one in particular. Keeping it would let a shared team mailbox merge those
 *    people, which is the failure this bridge must never produce.
 */
export function buildDeveloperEmailIndex(
  rows: { canonicalDeveloperId: string; email: string | null }[],
): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.email || isMachineEmail(row.email)) {
      continue;
    }
    const email = row.email.toLowerCase();
    const set = candidates.get(email) ?? new Set<string>();
    set.add(row.canonicalDeveloperId);
    candidates.set(email, set);
  }
  const index = new Map<string, string>();
  for (const [email, developers] of candidates) {
    if (developers.size === 1) {
      index.set(email, [...developers][0]);
    }
  }
  return index;
}

/** Stable key for a Jira assignee — the account reference, else the name. */
export function jiraSourceKeyOf(identity: JiraAssigneeIdentity): string | null {
  if (identity.login) {
    return `login:${identity.login}`;
  }
  const nameKey = normalizeIdentityKey(identity.name);
  // Keyed on the NORMALIZED name, not the raw one: "Priya Iyer" and
  // "priya.iyer" are one assignee to every rung below, so keying them
  // separately would upsert two rows that resolve to the same person and then
  // double-count them in any assignee roll-up.
  return nameKey ? `name:${nameKey}` : null;
}

/**
 * Resolves a Jira assignee to the canonical (GitHub-derived) developer.
 *
 * The ladder runs strongest-evidence-first, like `resolveIdentity`:
 *
 *   1. **the Atlassian account email matches one this person commits under**
 *      — a fact about a key that is unique per human, not an inference;
 *   2. the display name normalizes to exactly one known developer;
 *   3. the account reference does (Jira Server instances often use the
 *      corporate username; on Cloud it is an opaque uuid that never matches).
 *
 * Rung 1 is the one worth having, and it exists only where the instance
 * discloses the address: Jira Cloud omits `emailAddress` unless user-profile
 * visibility permits it. Where it is absent the ladder degrades to the two
 * name rungs — inference, recorded as `name_normalized` with evidence naming
 * which field carried the match — which is exactly the behaviour that shipped
 * before emails were collected at all.
 *
 * This is why the boards built on it must show their match rate. A Jira
 * assignee who fails to match is indistinguishable, downstream, from a
 * developer with no assigned work — and those mean opposite things. An
 * unmatched assignee gets its own `jira:` canonical id rather than being
 * dropped, so it stays countable as a known gap.
 *
 * Deliberately no fuzzy matching, for the reason `normalizeIdentityKey`
 * documents: attributing one colleague's tickets to another is worse than
 * leaving the link honestly unmade.
 */
export function resolveJiraIdentity(
  identity: JiraAssigneeIdentity,
  loginsByNameKey: Map<string, string[]>,
  /**
   * Lowercased email → canonical developer, built from identities GitHub
   * already resolved. Only unambiguous, non-machine addresses belong here —
   * see `buildDeveloperEmailIndex`.
   */
  developerByEmail: Map<string, string> = new Map(),
): IdentityMatch | null {
  const email = identity.email?.toLowerCase();
  // `isMachineEmail` guards the same failure as on the GitHub side: a shared
  // automation address identifies no one, and treating it as a person's would
  // merge every assignee who ever used it into a single phantom developer.
  if (email && !isMachineEmail(email)) {
    const byEmail = developerByEmail.get(email);
    if (byEmail) {
      return {
        canonicalDeveloperId: byEmail,
        confidence: IDENTITY_CONFIDENCE.email_exact,
        method: 'email_exact',
        evidence: {
          source: 'jira',
          matchedOn: 'email',
          email,
          matchedDeveloper: byEmail,
        },
      };
    }
  }

  // Display name first. It is the field humans maintain in both systems, and
  // on Jira Cloud the account reference is an opaque uuid that can only ever
  // fall through to the rung below.
  for (const [field, raw] of [
    ['name', identity.name],
    ['login', identity.login],
  ] as const) {
    const key = normalizeIdentityKey(raw);
    if (!key) {
      continue;
    }
    const candidates = loginsByNameKey.get(key) ?? [];
    if (candidates.length > 1) {
      // Two colleagues normalizing to one key. Picking either would assign a
      // real person's tickets to someone else and — because this feeds the
      // "committing without assigned work" list — could report the wronged
      // party as working off-plan. Refuse; the caller records an orphan.
      return null;
    }
    if (candidates.length === 1) {
      return {
        canonicalDeveloperId: candidates[0],
        confidence: IDENTITY_CONFIDENCE.name_normalized,
        method: 'name_normalized',
        evidence: {
          source: 'jira',
          matchedOn: field,
          value: raw,
          normalizedKey: key,
          matchedLogin: candidates[0],
        },
      };
    }
  }

  const key = jiraSourceKeyOf(identity);
  if (!key) {
    return null;
  }
  return {
    // Namespaced so it can never collide with a GitHub login, and so a read
    // model can tell a Jira-only person from a developer at a glance.
    canonicalDeveloperId: `jira:${key.replace(/^(login|name):/, '')}`,
    confidence: IDENTITY_CONFIDENCE.unresolved,
    method: 'unresolved',
    evidence: {
      source: 'jira',
      login: identity.login ?? null,
      name: identity.name ?? null,
    },
  };
}

/**
 * Resolves one observed identity to a canonical developer.
 *
 * The ladder runs strongest-evidence-first and stops at the first rung that
 * answers, so a weaker rule can never override a stronger one:
 *
 *   1. the source already told us the login;
 *   2. this exact email was seen on a commit GitHub DID attribute;
 *   3. the git author name normalizes to exactly one known login.
 *
 * Returns `null` when the identity is ambiguous (several candidate logins) —
 * the caller records that as an orphan for review. An unresolved identity gets
 * its own canonical id rather than being dropped, so its work is still counted
 * and still visible; it simply is not merged into anyone else.
 */
export function resolveIdentity(
  identity: SourceIdentity,
  loginByEmail: Map<string, string>,
  loginsByNameKey: Map<string, string[]>,
): IdentityMatch | null {
  if (identity.login) {
    return {
      canonicalDeveloperId: identity.login,
      confidence: IDENTITY_CONFIDENCE.github_login,
      method: 'github_login',
      evidence: { login: identity.login },
    };
  }

  const email = identity.email?.toLowerCase();
  if (email && !isMachineEmail(email)) {
    const byEmail = loginByEmail.get(email);
    if (byEmail) {
      return {
        canonicalDeveloperId: byEmail,
        confidence: IDENTITY_CONFIDENCE.email_exact,
        method: 'email_exact',
        evidence: { email, matchedLogin: byEmail },
      };
    }
  }

  const nameKey = normalizeIdentityKey(identity.name);
  if (nameKey) {
    const candidates = loginsByNameKey.get(nameKey) ?? [];
    if (candidates.length > 1) {
      // Several colleagues normalize to the same key. Picking one would be a
      // coin flip that silently credits someone else's work.
      return null;
    }
    if (candidates.length === 1) {
      return {
        canonicalDeveloperId: candidates[0],
        confidence: IDENTITY_CONFIDENCE.name_normalized,
        method: 'name_normalized',
        evidence: {
          name: identity.name,
          normalizedKey: nameKey,
          matchedLogin: candidates[0],
        },
      };
    }
  }

  const key = sourceKeyOf(identity);
  if (!key) {
    return null;
  }
  return {
    canonicalDeveloperId: key,
    confidence: IDENTITY_CONFIDENCE.unresolved,
    method: 'unresolved',
    evidence: { email: identity.email ?? null, name: identity.name ?? null },
  };
}
