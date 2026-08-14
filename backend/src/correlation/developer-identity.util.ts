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
