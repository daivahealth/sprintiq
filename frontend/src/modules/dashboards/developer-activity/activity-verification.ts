import { istDayKeyOffset, istDaySpan, istTodayKey } from '../../../lib/utils';
import { presetDateKeys, type ActivityRange } from '../activity-range';

/**
 * Developer activity verification — the response of
 * `POST /api/dashboards/developer-activity/verify`
 * (docs/features/DASHBOARDS.md §4.4.3), and the pure helpers the card
 * renders it with.
 */

/** Mirrors the API's `VERIFY_MAX_DAYS`. */
export const VERIFY_MAX_DAYS = 31;

export type DiscrepancyCategory =
  | 'missing_in_db'
  | 'mismatched'
  | 'only_in_db'
  | 'unverifiable'
  | 'pending_sync';

/** Categories that are not discrepancies: an unanswered question, and expected sync lag. */
const NOT_ACTIONABLE: DiscrepancyCategory[] = ['unverifiable', 'pending_sync'];

export function isActionable(item: { category: DiscrepancyCategory }): boolean {
  return !NOT_ACTIONABLE.includes(item.category);
}

export type DiscrepancyKind = 'commit' | 'pull_request' | 'review';

export interface FieldDiff {
  field: string;
  db: string | number | null;
  github: string | number | null;
}

export interface DiscrepancyItem {
  kind: DiscrepancyKind;
  category: DiscrepancyCategory;
  code: string;
  reason: string;
  repoFullName: string;
  ref: string;
  title: string;
  at?: string;
  url: string;
  diffs: FieldDiff[];
}

export type SummaryMetric =
  | 'commits'
  | 'additions'
  | 'deletions'
  | 'prsOpened'
  | 'prsMerged'
  | 'reviewsGiven';

export interface SummaryRow {
  metric: SummaryMetric;
  db: number;
  github: number;
  delta: number;
  complete: boolean;
}

export interface CategoryCounts {
  matched: number;
  missingInDb: number;
  mismatched: number;
  onlyInDb: number;
  unverifiable: number;
  /** Absent from an API that predates it. */
  pendingSync?: number;
}

export interface UnverifiedScope {
  kind: 'commits' | 'pull_requests' | 'reviews';
  repoFullName?: string;
  branch?: string;
  pullRequest?: string;
  reason: string;
  detail: string;
}

export interface ActivityVerificationReport {
  developer: string;
  identity: { logins: string[]; emails: string[] };
  range: { from: string; to: string };
  scope: 'active' | 'all';
  status: 'match' | 'discrepancies' | 'incomplete';
  summary: SummaryRow[];
  counts: {
    commits: CategoryCounts;
    pullRequests: CategoryCounts;
    reviews: CategoryCounts;
  };
  items: DiscrepancyItem[];
  unverified: UnverifiedScope[];
  coverage: {
    scope: 'active' | 'all';
    collectedRepos: number;
    reposScanned: string[];
    reposNotScanned: number;
    branchesScanned: number;
    branchesSkippedInactive: number;
    pullRequestsOutsideCollectedRepos: number;
    reviewsOutsideCollectedRepos: number;
    loginsResolved: string[];
    loginsUnresolved: string[];
    collectedThrough?: Record<string, string | null>;
    renamedRepos?: { collected: string; current: string }[];
    rateLimitRemaining?: number;
    durationMs: number;
    dbCommitsTruncated: boolean;
    dbPullRequestsTruncated: boolean;
    commitLookups: number;
    commitLookupsSkipped: number;
  };
  rules: string[];
  generatedAt: string;
}

export interface VerifyRequest {
  developer: string;
  from: string;
  to: string;
  scope: 'active' | 'all';
}

/**
 * The page's own range as a verifiable date pair: the same days the figures
 * above were computed over, cut to the most recent `VERIFY_MAX_DAYS` when the
 * page shows more. Starting on the page's range is what makes "do these
 * numbers match GitHub" a one-click question.
 */
export function defaultVerifyRange(range: ActivityRange): {
  from: string;
  to: string;
} {
  const pair =
    range.kind === 'custom'
      ? { from: range.from, to: range.to }
      : presetDateKeys(range.window);
  return clampVerifyRange(pair.from, pair.to);
}

/** Keeps the end, moves the start up to fit `VERIFY_MAX_DAYS`. */
export function clampVerifyRange(
  from: string,
  to: string,
): { from: string; to: string } {
  if (istDaySpan(from, to) <= VERIFY_MAX_DAYS) {
    return { from, to };
  }
  return { from: istDayKeyOffset(to, -(VERIFY_MAX_DAYS - 1)), to };
}

/** Why the Run button is disabled, or null when the range is runnable. */
export function verifyRangeProblem(from: string, to: string): string | null {
  if (!from || !to) return 'Choose both dates.';
  if (from > to) return 'The start date is after the end date.';
  if (from > istTodayKey()) return 'The range starts in the future.';
  if (istDaySpan(from, to) > VERIFY_MAX_DAYS) {
    return `A verification covers at most ${VERIFY_MAX_DAYS} days.`;
  }
  return null;
}

export const METRIC_LABELS: Record<SummaryMetric, string> = {
  commits: 'Commits',
  additions: 'Lines added',
  deletions: 'Lines deleted',
  prsOpened: 'PRs opened',
  prsMerged: 'PRs merged',
  reviewsGiven: 'Reviews given',
};

export const CATEGORY_LABELS: Record<DiscrepancyCategory, string> = {
  missing_in_db: 'On GitHub, missing in SprintIQ',
  mismatched: 'In both, details differ',
  only_in_db: 'In SprintIQ, not returned by GitHub',
  unverifiable: 'Could not be verified',
  pending_sync: 'On GitHub, newer than SprintIQ’s last sync',
};

export const CATEGORY_ORDER: DiscrepancyCategory[] = [
  'missing_in_db',
  'mismatched',
  'only_in_db',
  'unverifiable',
  'pending_sync',
];

export const KIND_LABELS: Record<DiscrepancyKind, string> = {
  commit: 'Commit',
  pull_request: 'Pull request',
  review: 'Review',
};

const REASON_LABELS: Record<string, string> = {
  rate_limited: 'rate-limited',
  budget_reserved: 'stopped to keep the rate-limit reserve',
  time_budget: 'ran out of time',
  forbidden: 'no access',
  not_found: 'not found on GitHub',
  failed: 'request failed',
  too_complex: 'GitHub timed out',
  truncated: 'too many results',
  no_token: 'no token stored',
  unsearchable_login: 'no searchable identity',
};

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason.replace(/_/g, ' ');
}

/** Items of one category, grouped by kind in a fixed order. */
export function groupItems(
  items: DiscrepancyItem[],
  category: DiscrepancyCategory,
): { kind: DiscrepancyKind; items: DiscrepancyItem[] }[] {
  const kinds: DiscrepancyKind[] = ['commit', 'pull_request', 'review'];
  return kinds
    .map((kind) => ({
      kind,
      items: items.filter((i) => i.category === category && i.kind === kind),
    }))
    .filter((g) => g.items.length > 0);
}

/** One sentence on the run, worded so "incomplete" never reads as "fine". */
export function verificationHeadline(r: ActivityVerificationReport): string {
  const actionable = r.items.filter(isActionable);
  const unverifiable = r.items.filter((i) => i.category === 'unverifiable').length;
  const pending = r.items.filter((i) => i.category === 'pending_sync').length;
  const pendingNote =
    pending > 0
      ? ` ${pending} newer record(s) on GitHub are not synced yet and are expected on the next sync.`
      : '';
  if (r.status === 'match') {
    return `Every stored commit, PR and review matches GitHub for this range.${pendingNote}`;
  }
  if (r.status === 'incomplete') {
    return `No discrepancy found in what could be checked, but ${
      unverifiable > 0
        ? `${unverifiable} stored record(s) could not be verified`
        : 'part of GitHub could not be read'
    } — see below.${pendingNote}`;
  }
  const parts = CATEGORY_ORDER.filter((c) => !NOT_ACTIONABLE.includes(c))
    .map((c) => [c, actionable.filter((i) => i.category === c).length] as const)
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${n} ${CATEGORY_LABELS[c].toLowerCase()}`);
  return `${actionable.length} discrepanc${actionable.length === 1 ? 'y' : 'ies'}: ${parts.join('; ')}.${
    r.unverified.length > 0 ? ' Part of GitHub could not be read — see below.' : ''
  }${pendingNote}`;
}

export function formatDelta(delta: number): string {
  if (delta === 0) return '0';
  return delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`;
}

/** Where an unverified scope sits, for its row label. */
export function scopeLabel(s: UnverifiedScope): string {
  const what =
    s.kind === 'commits'
      ? 'Commits'
      : s.kind === 'pull_requests'
        ? 'PR search'
        : 'Review search';
  const where = s.pullRequest ?? (s.branch ? `${s.repoFullName} · ${s.branch}` : s.repoFullName);
  return where ? `${what} · ${where}` : what;
}
