import type {
  CommitLookup,
  GithubActivitySnapshot,
  UnverifiedScope,
  VerifiedCommit,
  VerifiedPullRequest,
  VerifiedReview,
} from '../collectors/sources/github/github-activity-verify.service';
import { distinctCommitsBySha } from './commit-dedupe';
import { partitionMerges } from './merge-commits';

/**
 * Reconciles one developer's stored activity against an independent read of
 * GitHub (docs/features/DASHBOARDS.md §4.4.3). Pure: every input is passed
 * in, so each category below is unit-tested without a database or GitHub.
 *
 * Records are matched by identity — repo + SHA, repo + PR number, review id —
 * never by count, so a total that happens to agree cannot hide one missing
 * commit offset by one extra.
 *
 * Four outcomes per record, and the difference between the last two is the
 * contract this exists to keep:
 *  - `missing_in_db`  GitHub returned it; SprintIQ holds no row for it at all.
 *  - `mismatched`     both hold it, and a field differs (or SprintIQ does not
 *                     count it for this developer / range).
 *  - `only_in_db`     SprintIQ counts it; GitHub, asked a complete question,
 *                     did not return it.
 *  - `unverifiable`   SprintIQ counts it, but the part of GitHub that would
 *                     have returned it was not fully read (rate limit, access,
 *                     time budget, search-index lag). Never reported as missing.
 *  - `pending_sync`   GitHub has it, SprintIQ does not yet, and it is newer
 *                     than the repository's last completed sync — expected on
 *                     the next one, not a collection fault.
 *
 * The collector reads GitHub over REST by default and this verifier over
 * GraphQL; the comparisons below normalise the places the two transports
 * answer differently (bot logins, merge-commit line stats, repository renames
 * — the last in `GithubActivityVerifyService`) so a transport difference is
 * never reported as a data difference.
 */

export type DiscrepancyCategory =
  | 'missing_in_db'
  | 'mismatched'
  | 'only_in_db'
  | 'unverifiable'
  | 'pending_sync';

export interface FieldDiff {
  field: string;
  db: string | number | null;
  github: string | number | null;
}

export interface DiscrepancyItem {
  kind: 'commit' | 'pull_request' | 'review';
  category: DiscrepancyCategory;
  /** Machine-readable reason, e.g. `lines_not_recorded`, `not_on_github`. */
  code: string;
  /** One sentence an admin can act on. */
  reason: string;
  repoFullName: string;
  /** `abc1234` / `#12` / review id. */
  ref: string;
  title: string;
  /** committedAt / openedAt / submittedAt, whichever side has it. */
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
  /** False when part of what feeds the GitHub figure could not be read. */
  complete: boolean;
}

export interface CategoryCounts {
  matched: number;
  missingInDb: number;
  mismatched: number;
  onlyInDb: number;
  unverifiable: number;
  pendingSync: number;
}

export interface ReconciliationResult {
  status: 'match' | 'discrepancies' | 'incomplete';
  summary: SummaryRow[];
  counts: {
    commits: CategoryCounts;
    pullRequests: CategoryCounts;
    reviews: CategoryCounts;
  };
  items: DiscrepancyItem[];
  unverified: UnverifiedScope[];
}

/** The stored-row shapes the reconciler reads (subset of the Prisma models). */
export interface DbCommit {
  repoFullName: string;
  sha: string;
  message: string;
  authorLogin: string | null;
  authorEmail: string | null;
  authoredAt: Date;
  committedAt: Date | null;
  additions: number;
  deletions: number;
  parentCount: number | null;
}

export interface DbPullRequest {
  repoFullName: string;
  externalNumber: string;
  title: string;
  branch: string;
  state: string;
  authorLogin: string | null;
  additions: number;
  deletions: number;
  openedAt: Date | null;
  mergedAt: Date | null;
}

export interface DbReview {
  externalId: string;
  repoFullName: string;
  externalNumber: string;
  reviewerLogin: string | null;
  isBot: boolean;
  state: string;
  submittedAt: Date;
}

export interface ReconcileInput {
  /** What the Developer page counts for this person and range. */
  db: {
    commits: DbCommit[];
    pullRequests: DbPullRequest[];
    reviews: DbReview[];
  };
  /**
   * Stored rows for every record GitHub returned, looked up by identity alone
   * (no author or date filter) — how a record SprintIQ holds but attributes
   * elsewhere is told apart from one it never collected.
   */
  dbByKey: {
    commits: DbCommit[];
    pullRequests: DbPullRequest[];
    reviews: DbReview[];
  };
  github: GithubActivitySnapshot;
  /** Point lookups for `only_in_db` commit candidates. Absent = not looked up. */
  commitLookups: CommitLookup[];
  identity: { logins: string[]; emails: string[] };
  range: { from: Date; to: Date };
  /** When the GitHub read ran; defaults to now. Drives the search-lag window. */
  now?: Date;
}

/** Timestamps within a second are the same instant stored at different precisions. */
const SAME_INSTANT_MS = 1000;

/**
 * GitHub's search index trails writes, typically by seconds and occasionally
 * by minutes. A stored PR or review younger than this that search did not
 * return is "not indexed yet", not "not on GitHub".
 */
export const SEARCH_INDEX_LAG_MS = 15 * 60 * 1000;

/**
 * The same account under each transport's login. Measured (see
 * `isBotAccount` in github.client.ts): REST's `Copilot` is GraphQL's
 * `copilot-swe-agent` (and its reviewer `copilot-pull-request-reviewer`), and
 * REST's `name[bot]` is GraphQL's `name`. Keys are GraphQL's, lowercased.
 */
const GRAPHQL_LOGIN_ALIASES: Record<string, string> = {
  'copilot-swe-agent': 'copilot',
  'copilot-pull-request-reviewer': 'copilot',
};

/** One spelling per account across REST and GraphQL; logins are case-insensitive. */
export function canonicalLogin(login?: string | null): string | null {
  if (!login) return null;
  const l = login.toLowerCase().replace(/\[bot\]$/, '');
  return GRAPHQL_LOGIN_ALIASES[l] ?? l;
}

function sameLogin(a?: string | null, b?: string | null): boolean {
  return canonicalLogin(a) === canonicalLogin(b);
}

export function reconcileActivity(input: ReconcileInput): ReconciliationResult {
  const unverified = dedupeScopes(input.github.unverified);
  const items: DiscrepancyItem[] = [];
  const commits = reconcileCommits(input, unverified, items);
  const pullRequests = reconcilePulls(input, unverified, items);
  const reviews = reconcileReviews(input, unverified, items);

  const scopeComplete = (kind: UnverifiedScope['kind']) =>
    !unverified.some((u) => u.kind === kind);

  // Both sides counted by the page's own rules: one row per SHA, merges out.
  const dbCounted = partitionMerges(
    distinctCommitsBySha(input.db.commits).commits,
  ).authored;
  const ghCounted = partitionMerges(
    distinctCommitsBySha(input.github.commits).commits,
  ).authored;
  const sum = <T>(rows: T[], f: (r: T) => number) =>
    rows.reduce((n, r) => n + f(r), 0);
  const row = (
    metric: SummaryMetric,
    db: number,
    github: number,
    complete: boolean,
  ): SummaryRow => ({
    metric,
    db,
    github,
    delta: github - db,
    complete,
  });
  const commitsComplete = scopeComplete('commits');
  const prsComplete = scopeComplete('pull_requests');
  const summary: SummaryRow[] = [
    row('commits', dbCounted.length, ghCounted.length, commitsComplete),
    row(
      'additions',
      sum(dbCounted, (c) => c.additions),
      sum(ghCounted, (c) => c.additions),
      commitsComplete,
    ),
    row(
      'deletions',
      sum(dbCounted, (c) => c.deletions),
      sum(ghCounted, (c) => c.deletions),
      commitsComplete,
    ),
    row(
      'prsOpened',
      input.db.pullRequests.length,
      input.github.pullRequests.length,
      prsComplete,
    ),
    row(
      'prsMerged',
      input.db.pullRequests.filter((p) => p.mergedAt).length,
      input.github.pullRequests.filter((p) => p.mergedAt).length,
      prsComplete,
    ),
    row(
      'reviewsGiven',
      input.db.reviews.length,
      input.github.reviews.filter((r) => !r.isBot).length,
      scopeComplete('reviews'),
    ),
  ];

  // `pending_sync` is expected lag and `unverifiable` is an unanswered
  // question; neither is a discrepancy. Any unverifiable record — including
  // one with no scope behind it (lookup cap, search lag) — makes the run
  // incomplete rather than a match.
  const actionable = items.some(
    (i) => i.category !== 'unverifiable' && i.category !== 'pending_sync',
  );
  const unresolved =
    unverified.length > 0 || items.some((i) => i.category === 'unverifiable');
  return {
    status: actionable ? 'discrepancies' : unresolved ? 'incomplete' : 'match',
    summary,
    counts: { commits, pullRequests, reviews },
    items,
    unverified,
  };
}

// ---------------------------------------------------------------- commits

function reconcileCommits(
  input: ReconcileInput,
  unverified: UnverifiedScope[],
  items: DiscrepancyItem[],
): CategoryCounts {
  const counts = emptyCounts();
  const key = (repo: string, sha: string) => `${repo} ${sha}`;
  const attributed = new Map(
    input.db.commits.map((c) => [key(c.repoFullName, c.sha), c]),
  );
  const byKey = new Map(
    input.dbByKey.commits.map((c) => [key(c.repoFullName, c.sha), c]),
  );
  const bySha = new Map<string, DbCommit[]>();
  for (const c of input.dbByKey.commits) {
    bySha.set(c.sha, [...(bySha.get(c.sha) ?? []), c]);
  }
  const seen = new Set<string>();

  for (const gh of input.github.commits) {
    const k = key(gh.repoFullName, gh.sha);
    seen.add(k);
    const db = attributed.get(k) ?? byKey.get(k);
    if (!db) {
      const elsewhere = (bySha.get(gh.sha) ?? []).filter(
        (c) => c.repoFullName !== gh.repoFullName,
      );
      if (elsewhere.length > 0) {
        counts.mismatched += 1;
        items.push(
          commitItem(
            gh,
            'mismatched',
            'stored_under_other_repo',
            `Stored under ${elsewhere.map((c) => c.repoFullName).join(', ')}, not ${gh.repoFullName} where GitHub has it.`,
            [
              {
                field: 'repository',
                db: elsewhere[0].repoFullName,
                github: gh.repoFullName,
              },
            ],
          ),
        );
        continue;
      }
      const pending = pendingSync(
        input,
        gh.repoFullName,
        gh.committedAt,
        'commit',
      );
      if (pending) {
        counts.pendingSync += 1;
        items.push(
          commitItem(gh, 'pending_sync', 'not_collected_yet', pending, []),
        );
        continue;
      }
      counts.missingInDb += 1;
      items.push(
        commitItem(
          gh,
          'missing_in_db',
          'not_collected',
          `GitHub has this commit${whereFound(gh)}; SprintIQ has no record of it.`,
          [],
        ),
      );
      continue;
    }
    const diffs = commitDiffs(db, gh);
    if (!attributed.has(k)) {
      diffs.unshift(attributionDiff(db, input));
    }
    if (diffs.length === 0) {
      counts.matched += 1;
      continue;
    }
    counts.mismatched += 1;
    const drift = attributionDrift(db, gh, diffs, input.identity);
    items.push(
      commitItem(
        gh,
        'mismatched',
        drift ? 'attribution_updated_on_github' : mismatchCode(diffs),
        drift ?? mismatchReason(diffs),
        diffs,
      ),
    );
  }

  const lookups = new Map(
    input.commitLookups.map((l) => [key(l.repoFullName, l.sha), l]),
  );
  for (const db of input.db.commits) {
    const k = key(db.repoFullName, db.sha);
    if (seen.has(k)) continue;
    const gap = commitScopeGap(
      unverified,
      db.repoFullName,
      input.github.coverage.reposScanned,
    );
    const lookup = lookups.get(k);
    if (lookup?.status === 'not_found') {
      // A definite answer: the point lookup does not depend on the range scan.
      counts.onlyInDb += 1;
      items.push(
        dbCommitItem(
          db,
          'only_in_db',
          'not_on_github',
          'GitHub has no commit with this SHA in this repository (force-pushed away, or the repository was rewritten).',
          [],
        ),
      );
      continue;
    }
    if (lookup?.status === 'found') {
      const diffs = commitDiffs(db, lookup.commit);
      const ghOutOfRange = outside(lookup.commit.committedAt, input.range);
      const ghNotTheirs = !attributedTo(lookup.commit, input.identity);
      if (ghOutOfRange || ghNotTheirs) {
        counts.onlyInDb += 1;
        items.push(
          dbCommitItem(
            db,
            'only_in_db',
            'github_disagrees',
            ghNotTheirs
              ? 'GitHub attributes this commit to a different author than SprintIQ does.'
              : 'GitHub dates this commit outside the selected range.',
            diffs,
          ),
        );
        continue;
      }
      if (gap) {
        counts.unverifiable += 1;
        items.push(
          dbCommitItem(
            db,
            'unverifiable',
            'scope_not_read',
            `Exists on GitHub, but ${gap} — whether it is on a live branch could not be checked.`,
            diffs,
          ),
        );
        continue;
      }
      const rewrite = rewrittenAs(db, input.github.commits);
      if (rewrite) {
        const replacement = rewrite.commit;
        counts.onlyInDb += 1;
        items.push(
          dbCommitItem(
            db,
            'only_in_db',
            'rewritten_on_github',
            `Rewritten on GitHub (rebase, amend or force-push): replaced by ${replacement.sha.slice(0, 7)}${whereFound(replacement)}, same author and author date${
              rewrite.messageEdited ? ', message edited' : ' and message'
            }. SprintIQ still holds this old SHA${
              input.dbByKey.commits.some((c) => c.sha === replacement.sha)
                ? ' as well as the replacement, so the work is counted twice'
                : ''
            }.`,
            [{ field: 'sha', db: db.sha, github: replacement.sha }],
          ),
        );
        continue;
      }
      counts.onlyInDb += 1;
      items.push(
        dbCommitItem(
          db,
          'only_in_db',
          'not_on_live_branch',
          'Exists on GitHub, but is on no current branch and in none of this developer’s pull requests in the range — its branch was deleted or squash-merged, or it was rewritten with a different message. Counted by SprintIQ; not reachable on GitHub today.',
          diffs,
        ),
      );
      continue;
    }
    if (gap) {
      counts.unverifiable += 1;
      items.push(
        dbCommitItem(
          db,
          'unverifiable',
          'scope_not_read',
          `Not returned by GitHub, but ${gap}, so this cannot be called missing.`,
          [],
        ),
      );
      continue;
    }
    counts.unverifiable += 1;
    items.push(
      dbCommitItem(
        db,
        'unverifiable',
        'not_looked_up',
        'Not returned by the range query, and the per-commit lookup did not run for it (lookup cap).',
        [],
      ),
    );
  }
  return counts;
}

/** Why the GitHub scan cannot speak for this repository's commits; undefined when it can. */
function commitScopeGap(
  unverified: UnverifiedScope[],
  repoFullName: string,
  scanned: string[],
): string | undefined {
  if (!scanned.includes(repoFullName)) {
    return 'this repository’s branches were not read';
  }
  const hit = unverified.find(
    (u) =>
      u.kind === 'commits' &&
      (!u.repoFullName || u.repoFullName === repoFullName),
  );
  return hit
    ? `part of this repository was not read (${hit.reason})`
    : undefined;
}

function commitDiffs(db: DbCommit, gh: VerifiedCommit): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  // A merge's line stats depend on which parent it is diffed against, and the
  // two transports need not agree. Merges count toward no line total
  // (METRICS.md §0), so a difference there is noise, never a finding.
  const isMerge = (db.parentCount ?? 0) > 1 || gh.parentCount > 1;
  if (!isMerge && db.additions !== gh.additions)
    diffs.push({ field: 'additions', db: db.additions, github: gh.additions });
  if (!isMerge && db.deletions !== gh.deletions)
    diffs.push({ field: 'deletions', db: db.deletions, github: gh.deletions });
  if (!db.committedAt || !sameInstant(db.committedAt, gh.committedAt)) {
    diffs.push({
      field: 'committedAt',
      db: db.committedAt?.toISOString() ?? null,
      github: gh.committedAt,
    });
  }
  if (!sameLogin(db.authorLogin, gh.authorLogin)) {
    diffs.push({
      field: 'authorLogin',
      db: db.authorLogin,
      github: gh.authorLogin ?? null,
    });
  }
  if (
    db.authorEmail &&
    gh.authorEmail &&
    db.authorEmail.toLowerCase() !== gh.authorEmail.toLowerCase()
  ) {
    diffs.push({
      field: 'authorEmail',
      db: db.authorEmail,
      github: gh.authorEmail,
    });
  }
  // Null = never learned; a merge flag we do not have is unknown, not wrong.
  if (db.parentCount !== null && db.parentCount !== gh.parentCount) {
    diffs.push({
      field: 'parentCount',
      db: db.parentCount,
      github: gh.parentCount,
    });
  }
  return diffs;
}

function mismatchCode(diffs: FieldDiff[]): string {
  const fields = new Set(diffs.map((d) => d.field));
  if (fields.has('attribution')) return 'not_counted_for_developer';
  if (
    diffs.some(
      (d) => (d.field === 'additions' || d.field === 'deletions') && d.db === 0,
    )
  ) {
    const lines = diffs.filter(
      (d) => d.field === 'additions' || d.field === 'deletions',
    );
    if (lines.every((d) => d.db === 0)) return 'lines_not_recorded';
  }
  return `field_mismatch:${[...fields].sort().join(',')}`;
}

function mismatchReason(diffs: FieldDiff[]): string {
  const attribution = diffs.find((d) => d.field === 'attribution');
  if (attribution) return String(attribution.db);
  if (mismatchCode(diffs) === 'lines_not_recorded') {
    return 'SprintIQ stored this commit with no line changes; GitHub reports some.';
  }
  return `Stored ${diffs.map((d) => d.field).join(', ')} differ from GitHub.`;
}

function attributionDiff(
  db: {
    authorLogin: string | null;
    authorEmail?: string | null;
    committedAt?: Date | null;
    openedAt?: Date | null;
    submittedAt?: Date;
  },
  input: ReconcileInput,
): FieldDiff {
  const at = db.committedAt ?? db.openedAt ?? db.submittedAt ?? null;
  const inRange = at ? !outside(at.toISOString(), input.range) : false;
  const why = !inRange
    ? `SprintIQ holds it dated ${at?.toISOString() ?? 'unknown'}, outside the range, so it is not counted here.`
    : `SprintIQ holds it under author ${db.authorLogin ?? db.authorEmail ?? 'unknown'}, which is not one of this developer’s identities, so it is not counted for them.`;
  return {
    field: 'attribution',
    db: why,
    github: 'counted for this developer in range',
  };
}

function attributedTo(
  c: { authorLogin?: string | null; authorEmail?: string | null },
  identity: ReconcileInput['identity'],
): boolean {
  if (c.authorLogin) return identity.logins.includes(c.authorLogin);
  const emails = new Set(identity.emails.map((e) => e.toLowerCase()));
  return Boolean(c.authorEmail && emails.has(c.authorEmail.toLowerCase()));
}

/**
 * The commit's login changed on GitHub after collection while both sides
 * still credit this developer — GitHub re-attributes history when an email
 * is added to (or removed from) an account. A real field difference, but
 * stale attribution, not lost or wrong data; the reason says so.
 */
function attributionDrift(
  db: DbCommit,
  gh: VerifiedCommit,
  diffs: FieldDiff[],
  identity: ReconcileInput['identity'],
): string | undefined {
  if (!diffs.every((d) => d.field === 'authorLogin')) return undefined;
  if (!attributedTo(db, identity) || !attributedTo(gh, identity)) {
    return undefined;
  }
  return db.authorLogin
    ? `GitHub no longer links this commit to ${db.authorLogin}; it still matches this developer by email. Counted for them either way — the stored login is stale.`
    : `GitHub now links this commit to ${gh.authorLogin} (the email was added to the account after collection); SprintIQ still stores it with no login. Counted for this developer either way.`;
}

/**
 * The commit GitHub now has in place of a stored one that no live branch
 * reaches. A rebase, amend or force-push re-creates a commit with a new SHA
 * and committer date but keeps its author, author date and message — found
 * live, where a rebase replayed eight commits within five seconds and the
 * old SHAs read as "deleted branch". Same repo, same author (login or email),
 * same author instant, same subject line; ambiguous matches are not paired.
 */
function rewrittenAs(
  db: DbCommit,
  github: VerifiedCommit[],
): { commit: VerifiedCommit; messageEdited: boolean } | undefined {
  const subject = db.message.split('\n')[0].trim();
  const sameAuthorAndInstant = github.filter(
    (gh) =>
      gh.repoFullName === db.repoFullName &&
      gh.sha !== db.sha &&
      sameInstant(db.authoredAt, gh.authoredAt) &&
      (sameLogin(db.authorLogin, gh.authorLogin) ||
        Boolean(
          db.authorEmail &&
          gh.authorEmail &&
          db.authorEmail.toLowerCase() === gh.authorEmail.toLowerCase(),
        )),
  );
  const exact = sameAuthorAndInstant.filter(
    (gh) => gh.message.trim() === subject,
  );
  if (exact.length === 1) return { commit: exact[0], messageEdited: false };
  // An interactive rebase can reword the subject too (found live: subjects
  // citing other SHAs that were themselves rewritten). The author instant is
  // to the second and the author is the same, so a SINGLE candidate is still
  // the replacement; more than one is ambiguous and stays unpaired.
  if (exact.length === 0 && sameAuthorAndInstant.length === 1) {
    return { commit: sameAuthorAndInstant[0], messageEdited: true };
  }
  return undefined;
}

/**
 * Why a record GitHub has is not in SprintIQ yet, when the reason is timing:
 * it is newer than its repository's last completed sync, or the repository is
 * still backfilling. Undefined when SprintIQ should already hold it.
 */
function pendingSync(
  input: ReconcileInput,
  repoFullName: string,
  at: string | undefined,
  kind: 'commit' | 'other' = 'other',
): string | undefined {
  const through = input.github.coverage.collectedThrough;
  if (!through || !(repoFullName in through) || !at) return undefined;
  const watermark = through[repoFullName];
  if (watermark === null) {
    return 'Not in SprintIQ yet: this repository is still backfilling, so its history is not complete.';
  }
  const t = new Date(at);
  if (t > new Date(watermark)) {
    return `Not in SprintIQ yet: newer than this repository’s last completed sync (${watermark}). Expected on the next sync.`;
  }
  // Commits on non-default branches arrive only through the audit-log route,
  // so a commit is only due once THAT route has passed it too. Found live:
  // feature-branch commits from the day after the route's checkpoint were
  // reported missing while the poller's watermark was already past them.
  const audit = input.github.coverage.branchCommitsCollectedThrough;
  if (kind === 'commit' && audit !== undefined) {
    if (audit === null) {
      return 'Not in SprintIQ yet: the audit-log route that collects branch commits has never completed a run.';
    }
    if (t > new Date(audit)) {
      return `Not in SprintIQ yet: newer than the audit-log route’s checkpoint (${audit}), which collects commits on non-default branches. Expected on its next run — if that checkpoint is old, check the route on Sync Status.`;
    }
  }
  return undefined;
}

/** The repo's watermark, when GitHub says this PR merged after it; undefined otherwise. */
function mergedAfterSync(
  input: ReconcileInput,
  gh: VerifiedPullRequest,
): string | undefined {
  const watermark = input.github.coverage.collectedThrough?.[gh.repoFullName];
  if (!watermark || !gh.mergedAt) return undefined;
  return new Date(gh.mergedAt) > new Date(watermark) ? watermark : undefined;
}

/** Stored, not returned by search, and young enough that search may not have indexed it. */
function withinSearchLag(input: ReconcileInput, at: Date | null): boolean {
  if (!at) return false;
  const now = (input.now ?? new Date()).getTime();
  return now - at.getTime() < SEARCH_INDEX_LAG_MS;
}

function whereFound(gh: VerifiedCommit): string {
  const where = [
    ...gh.branches.slice(0, 3).map((b) => `branch ${b}`),
    ...gh.pullRequests.slice(0, 2),
  ];
  return where.length > 0 ? ` (${where.join(', ')})` : '';
}

function commitItem(
  gh: VerifiedCommit,
  category: DiscrepancyCategory,
  code: string,
  reason: string,
  diffs: FieldDiff[],
): DiscrepancyItem {
  return {
    kind: 'commit',
    category,
    code,
    reason,
    repoFullName: gh.repoFullName,
    ref: gh.sha.slice(0, 7),
    title: gh.message,
    at: gh.committedAt,
    url: `https://github.com/${gh.repoFullName}/commit/${gh.sha}`,
    diffs,
  };
}

function dbCommitItem(
  db: DbCommit,
  category: DiscrepancyCategory,
  code: string,
  reason: string,
  diffs: FieldDiff[],
): DiscrepancyItem {
  return {
    kind: 'commit',
    category,
    code,
    reason,
    repoFullName: db.repoFullName,
    ref: db.sha.slice(0, 7),
    title: db.message.split('\n')[0],
    at: (db.committedAt ?? db.authoredAt).toISOString(),
    url: `https://github.com/${db.repoFullName}/commit/${db.sha}`,
    diffs,
  };
}

// ---------------------------------------------------------- pull requests

function reconcilePulls(
  input: ReconcileInput,
  unverified: UnverifiedScope[],
  items: DiscrepancyItem[],
): CategoryCounts {
  const counts = emptyCounts();
  const key = (repo: string, n: string) => `${repo}#${n}`;
  const attributed = new Map(
    input.db.pullRequests.map((p) => [
      key(p.repoFullName, p.externalNumber),
      p,
    ]),
  );
  const byKey = new Map(
    input.dbByKey.pullRequests.map((p) => [
      key(p.repoFullName, p.externalNumber),
      p,
    ]),
  );
  const seen = new Set<string>();

  for (const gh of input.github.pullRequests) {
    const k = key(gh.repoFullName, gh.number);
    seen.add(k);
    const db = attributed.get(k) ?? byKey.get(k);
    if (!db) {
      const pending = pendingSync(input, gh.repoFullName, gh.openedAt);
      if (pending) {
        counts.pendingSync += 1;
        items.push(
          pullItem(
            gh.repoFullName,
            gh.number,
            gh.title,
            gh.openedAt,
            'pending_sync',
            'not_collected_yet',
            pending,
            [],
          ),
        );
        continue;
      }
      counts.missingInDb += 1;
      items.push(
        pullItem(
          gh.repoFullName,
          gh.number,
          gh.title,
          gh.openedAt,
          'missing_in_db',
          'not_collected',
          'GitHub has this pull request; SprintIQ has no record of it.',
          [],
        ),
      );
      continue;
    }
    const diffs = pullDiffs(db, gh);
    if (!attributed.has(k)) diffs.unshift(attributionDiff(db, input));
    if (diffs.length === 0) {
      counts.matched += 1;
      continue;
    }
    // Merged after the repo's last completed sync: the stored row predates
    // the merge, and the merge also moves the PR's line totals. Found live
    // (`anga#3`, merged 5 hours after the repo's watermark).
    const mergedSince = mergedAfterSync(input, gh);
    if (
      mergedSince &&
      diffs.every((d) =>
        ['state', 'mergedAt', 'additions', 'deletions'].includes(d.field),
      )
    ) {
      counts.pendingSync += 1;
      items.push(
        pullItem(
          gh.repoFullName,
          gh.number,
          gh.title,
          gh.openedAt,
          'pending_sync',
          'changed_since_sync',
          `Merged on GitHub at ${gh.mergedAt}, after this repository’s last completed sync (${mergedSince}); the stored row predates the merge. Expected on the next sync.`,
          diffs,
        ),
      );
      continue;
    }
    counts.mismatched += 1;
    items.push(
      pullItem(
        gh.repoFullName,
        gh.number,
        gh.title,
        gh.openedAt,
        'mismatched',
        mismatchCode(diffs),
        mismatchReason(diffs),
        diffs,
      ),
    );
  }

  const gap = unverified.find((u) => u.kind === 'pull_requests');
  for (const db of input.db.pullRequests) {
    const k = key(db.repoFullName, db.externalNumber);
    if (seen.has(k)) continue;
    const at = db.openedAt?.toISOString();
    if (gap) {
      counts.unverifiable += 1;
      items.push(
        pullItem(
          db.repoFullName,
          db.externalNumber,
          db.title,
          at,
          'unverifiable',
          'scope_not_read',
          `Not returned by GitHub, but the pull-request search did not complete (${gap.reason}).`,
          [],
        ),
      );
      continue;
    }
    if (withinSearchLag(input, db.openedAt)) {
      counts.unverifiable += 1;
      items.push(
        pullItem(
          db.repoFullName,
          db.externalNumber,
          db.title,
          at,
          'unverifiable',
          'search_index_lag',
          'Opened in the last few minutes; GitHub’s search index may not include it yet. Run the verification again shortly.',
          [],
        ),
      );
      continue;
    }
    counts.onlyInDb += 1;
    items.push(
      pullItem(
        db.repoFullName,
        db.externalNumber,
        db.title,
        at,
        'only_in_db',
        'not_returned',
        'GitHub’s search did not return this pull request for this author and range — check its author and created date on GitHub.',
        [],
      ),
    );
  }
  return counts;
}

function pullDiffs(db: DbPullRequest, gh: VerifiedPullRequest): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  if (db.state !== gh.state)
    diffs.push({ field: 'state', db: db.state, github: gh.state });
  if (!sameOptionalInstant(db.mergedAt, gh.mergedAt)) {
    diffs.push({
      field: 'mergedAt',
      db: db.mergedAt?.toISOString() ?? null,
      github: gh.mergedAt ?? null,
    });
  }
  if (!sameOptionalInstant(db.openedAt, gh.openedAt)) {
    diffs.push({
      field: 'openedAt',
      db: db.openedAt?.toISOString() ?? null,
      github: gh.openedAt,
    });
  }
  if (!sameLogin(db.authorLogin, gh.authorLogin)) {
    diffs.push({
      field: 'authorLogin',
      db: db.authorLogin,
      github: gh.authorLogin ?? null,
    });
  }
  if (db.additions !== gh.additions)
    diffs.push({ field: 'additions', db: db.additions, github: gh.additions });
  if (db.deletions !== gh.deletions)
    diffs.push({ field: 'deletions', db: db.deletions, github: gh.deletions });
  return diffs;
}

function pullItem(
  repoFullName: string,
  number: string,
  title: string,
  at: string | undefined,
  category: DiscrepancyCategory,
  code: string,
  reason: string,
  diffs: FieldDiff[],
): DiscrepancyItem {
  return {
    kind: 'pull_request',
    category,
    code,
    reason,
    repoFullName,
    ref: `#${number}`,
    title,
    at,
    url: `https://github.com/${repoFullName}/pull/${number}`,
    diffs,
  };
}

// ---------------------------------------------------------------- reviews

function reconcileReviews(
  input: ReconcileInput,
  unverified: UnverifiedScope[],
  items: DiscrepancyItem[],
): CategoryCounts {
  const counts = emptyCounts();
  const attributed = new Map(input.db.reviews.map((r) => [r.externalId, r]));
  const byKey = new Map(input.dbByKey.reviews.map((r) => [r.externalId, r]));
  const seen = new Set<string>();

  for (const gh of input.github.reviews) {
    if (gh.isBot) continue;
    seen.add(gh.externalId);
    const db = attributed.get(gh.externalId) ?? byKey.get(gh.externalId);
    if (!db) {
      const pending = pendingSync(input, gh.repoFullName, gh.submittedAt);
      if (pending) {
        counts.pendingSync += 1;
        items.push(
          reviewItem(
            gh.externalId,
            gh.repoFullName,
            gh.number,
            gh.submittedAt,
            'pending_sync',
            'not_collected_yet',
            pending,
            [],
          ),
        );
        continue;
      }
      counts.missingInDb += 1;
      items.push(
        reviewItem(
          gh.externalId,
          gh.repoFullName,
          gh.number,
          gh.submittedAt,
          'missing_in_db',
          'not_collected',
          'GitHub has this review; SprintIQ has no record of it.',
          [],
        ),
      );
      continue;
    }
    const diffs = reviewDiffs(db, gh);
    if (!attributed.has(gh.externalId)) {
      diffs.unshift(
        attributionDiff(
          { authorLogin: db.reviewerLogin, submittedAt: db.submittedAt },
          input,
        ),
      );
    }
    if (diffs.length === 0) {
      counts.matched += 1;
      continue;
    }
    counts.mismatched += 1;
    items.push(
      reviewItem(
        gh.externalId,
        gh.repoFullName,
        gh.number,
        gh.submittedAt,
        'mismatched',
        mismatchCode(diffs),
        mismatchReason(diffs),
        diffs,
      ),
    );
  }

  const gap = unverified.find((u) => u.kind === 'reviews');
  for (const db of input.db.reviews) {
    if (seen.has(db.externalId)) continue;
    const at = db.submittedAt.toISOString();
    if (gap) {
      counts.unverifiable += 1;
      items.push(
        reviewItem(
          db.externalId,
          db.repoFullName,
          db.externalNumber,
          at,
          'unverifiable',
          'scope_not_read',
          `Not returned by GitHub, but the review search did not complete (${gap.reason}).`,
          [],
        ),
      );
      continue;
    }
    if (withinSearchLag(input, db.submittedAt)) {
      counts.unverifiable += 1;
      items.push(
        reviewItem(
          db.externalId,
          db.repoFullName,
          db.externalNumber,
          at,
          'unverifiable',
          'search_index_lag',
          'Submitted in the last few minutes; GitHub’s search index may not include it yet. Run the verification again shortly.',
          [],
        ),
      );
      continue;
    }
    counts.onlyInDb += 1;
    items.push(
      reviewItem(
        db.externalId,
        db.repoFullName,
        db.externalNumber,
        at,
        'only_in_db',
        'not_returned',
        'GitHub did not return this review for this reviewer and range — it may have been deleted, or its pull request is outside the searched organisations.',
        [],
      ),
    );
  }
  return counts;
}

function reviewDiffs(db: DbReview, gh: VerifiedReview): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  if (db.state !== gh.state)
    diffs.push({ field: 'state', db: db.state, github: gh.state });
  if (!sameInstant(db.submittedAt, gh.submittedAt)) {
    diffs.push({
      field: 'submittedAt',
      db: db.submittedAt.toISOString(),
      github: gh.submittedAt,
    });
  }
  if (!sameLogin(db.reviewerLogin, gh.reviewerLogin)) {
    diffs.push({
      field: 'reviewerLogin',
      db: db.reviewerLogin,
      github: gh.reviewerLogin ?? null,
    });
  }
  if (db.repoFullName !== gh.repoFullName || db.externalNumber !== gh.number) {
    diffs.push({
      field: 'pullRequest',
      db: `${db.repoFullName}#${db.externalNumber}`,
      github: `${gh.repoFullName}#${gh.number}`,
    });
  }
  return diffs;
}

function reviewItem(
  id: string,
  repoFullName: string,
  number: string,
  at: string | undefined,
  category: DiscrepancyCategory,
  code: string,
  reason: string,
  diffs: FieldDiff[],
): DiscrepancyItem {
  return {
    kind: 'review',
    category,
    code,
    reason,
    repoFullName,
    ref: `#${number} review ${id}`,
    title: `Review on ${repoFullName}#${number}`,
    at,
    url: `https://github.com/${repoFullName}/pull/${number}#pullrequestreview-${id}`,
    diffs,
  };
}

// ---------------------------------------------------------------- helpers

function emptyCounts(): CategoryCounts {
  return {
    matched: 0,
    missingInDb: 0,
    mismatched: 0,
    onlyInDb: 0,
    unverifiable: 0,
    pendingSync: 0,
  };
}

function sameInstant(db: Date, gh: string): boolean {
  return Math.abs(db.getTime() - new Date(gh).getTime()) < SAME_INSTANT_MS;
}

function sameOptionalInstant(db: Date | null, gh: string | undefined): boolean {
  if (!db || !gh) return !db && !gh;
  return sameInstant(db, gh);
}

function outside(at: string, range: { from: Date; to: Date }): boolean {
  const t = new Date(at).getTime();
  return t < range.from.getTime() || t > range.to.getTime();
}

/** One line per distinct scope — a halted run otherwise repeats itself per login and owner. */
function dedupeScopes(scopes: UnverifiedScope[]): UnverifiedScope[] {
  const seen = new Set<string>();
  return scopes.filter((s) => {
    const k = [s.kind, s.repoFullName, s.branch, s.pullRequest, s.reason].join(
      '|',
    );
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
