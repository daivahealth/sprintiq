import type { TrackedDeveloper } from '../../lib/api/types';

/**
 * Alphabetical by display name — never by activity, and never by the raw
 * login, which would file "Priya Iyer" under "p-iyer93" instead of "P". Ties
 * (two people sharing a display name) fall back to the login so the order is
 * stable rather than depending on fetch/array order.
 */
export function sortByDisplayName(
  items: TrackedDeveloper[],
): TrackedDeveloper[] {
  return [...items].sort((a, b) => {
    const byName = a.displayName.localeCompare(b.displayName, undefined, {
      sensitivity: 'base',
    });
    return byName !== 0 ? byName : a.developer.localeCompare(b.developer);
  });
}

export interface ResolutionBadge {
  tone: 'good' | 'warn';
  label: string;
  /** Only meaningful (and only rendered) when `tone` is 'warn'. */
  explanation: string;
}

/**
 * What the resolution badge says, and why `resolved: false` is never a
 * neutral state.
 *
 * An unresolved entry matches no developer identity resolution knows, so the
 * no-commit-detection roster evaluation can never flag it — not as idle, not
 * as active. The digest reports it as unresolved. Read plainly, that means
 * this is a broken roster entry to fix or remove, not a person who did
 * nothing — the exact confusion this page exists to prevent.
 */
export function resolutionBadge(resolved: boolean): ResolutionBadge {
  if (resolved) {
    return {
      tone: 'good',
      label: 'Resolved',
      explanation: '',
    };
  }
  return {
    tone: 'warn',
    label: 'Unresolved',
    explanation:
      'This entry matches no developer the system knows. Nobody will ever be flagged for it — the daily digest reports it as unresolved, not as someone idle. Fix or remove this entry.',
  };
}
