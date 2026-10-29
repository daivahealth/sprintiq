import { Injectable, Logger } from '@nestjs/common';
import { Connection } from '@prisma/client';
import { forEachBounded } from '../../../common/concurrency';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { PrismaService } from '../../../database/prisma.service';
import { GithubGraphqlClient, GraphqlResult } from './github-graphql.client';
import { GithubRateLimit } from './github.client';
import { evaluateBudget, rateReserve } from './github-rate-budget';

/**
 * Read-only, independent re-collection of ONE developer's GitHub activity for
 * a date range, so it can be reconciled against what SprintIQ stored
 * (`ActivityVerificationService`, docs/features/DASHBOARDS.md §4.4.3).
 *
 * BC-1 because it is a call to a source system — collectors are the only door
 * to the outside world. It writes nothing: no raw event, no envelope, no
 * cursor. Its answer is evidence about the pipeline, not input to it.
 *
 * Independence is the point. It does not reuse the collector's cursors, the
 * audit route's stored tips, or anything else the pipeline wrote, because a
 * check that reads the pipeline's own bookkeeping inherits its blind spots.
 * The one concession is `hintRepos`: which repositories to look in may be
 * seeded from the DB, but what is found there comes from GitHub alone.
 *
 * Every scope it could not read completely is reported in `unverified` with a
 * reason. The reconciler relies on that: a record absent from a scope that was
 * not fully read is "could not verify", never "missing".
 */

/** Why part of the requested range was not (fully) read from GitHub. */
export type UnverifiedReason =
  | 'rate_limited'
  | 'budget_reserved'
  | 'time_budget'
  | 'forbidden'
  | 'not_found'
  | 'failed'
  | 'too_complex'
  | 'truncated'
  | 'no_token'
  | 'unsearchable_login';

export interface UnverifiedScope {
  kind: 'commits' | 'pull_requests' | 'reviews';
  /** Absent for a scope wider than one repository (an org-wide search). */
  repoFullName?: string;
  branch?: string;
  pullRequest?: string;
  reason: UnverifiedReason;
  detail: string;
}

export interface VerifiedCommit {
  repoFullName: string;
  sha: string;
  message: string;
  authorLogin?: string;
  authorName?: string;
  authorEmail?: string;
  authoredAt: string;
  committedAt: string;
  additions: number;
  deletions: number;
  parentCount: number;
  /** Live branches whose history returned it (may be empty: PR-only). */
  branches: string[];
  /** The developer's PRs whose commit list returned it. */
  pullRequests: string[];
}

export interface VerifiedPullRequest {
  repoFullName: string;
  number: string;
  title: string;
  state: 'open' | 'merged' | 'closed';
  authorLogin?: string;
  openedAt: string;
  mergedAt?: string;
  additions: number;
  deletions: number;
  headRef?: string;
}

export interface VerifiedReview {
  /** GitHub's numeric review id — what `code_pr_review.externalId` stores. */
  externalId: string;
  repoFullName: string;
  number: string;
  reviewerLogin?: string;
  isBot: boolean;
  state: string;
  submittedAt: string;
}

export interface GithubActivitySnapshot {
  commits: VerifiedCommit[];
  pullRequests: VerifiedPullRequest[];
  reviews: VerifiedReview[];
  unverified: UnverifiedScope[];
  coverage: {
    scope: 'active' | 'all';
    collectedRepos: number;
    /** Repositories whose branches were read (fully or partly — see `unverified`). */
    reposScanned: string[];
    /** Collected, but not looked in: no sign of this developer there (scope `active`). */
    reposNotScanned: number;
    branchesScanned: number;
    /** Branches whose tip predates the range, so cannot hold a commit in it. */
    branchesSkippedInactive: number;
    /** GitHub has these, but SprintIQ does not collect their repository. */
    pullRequestsOutsideCollectedRepos: number;
    reviewsOutsideCollectedRepos: number;
    loginsResolved: string[];
    /** Logins GitHub has no user for (renamed/deleted) — their commits can only match by email. */
    loginsUnresolved: string[];
    /**
     * Each collected repo's `collectedThroughAt` (ISO; null while backfilling)
     * — the source time SprintIQ is complete through, so the reconciler can
     * tell "not collected" from "not synced yet".
     */
    collectedThrough: Record<string, string | null>;
    /**
     * The audit-log route's `checkpointAt` (ADR-0010): commits on non-default
     * branches arrive only through it, so for them SprintIQ is complete
     * through the EARLIER of this and the repo's `collectedThrough`. Null when
     * the route has never checkpointed; absent when it is not configured.
     */
    branchCommitsCollectedThrough?: string | null;
    /**
     * Collected under one name, called another by GitHub today (renamed or
     * transferred; or the same name in different case). Search results are
     * mapped back to the collected name before comparison.
     */
    renamedRepos: { collected: string; current: string }[];
    rateLimitRemaining?: number;
    durationMs: number;
  };
}

export interface VerifyActivityInput {
  tenantId: string;
  logins: string[];
  emails: string[];
  from: Date;
  to: Date;
  /** `active`: only repos with a sign of this developer; `all`: every collected repo. */
  scope: 'active' | 'all';
  /** Repos the caller already associates with the developer (DB-derived). */
  hintRepos?: string[];
}

export type CommitLookup =
  | {
      repoFullName: string;
      sha: string;
      status: 'found';
      commit: VerifiedCommit;
    }
  | { repoFullName: string; sha: string; status: 'not_found' }
  | {
      repoFullName: string;
      sha: string;
      status: 'unverified';
      reason: UnverifiedReason;
    };

/** Branch-history slots per query. ADR-0008: latency, not points, is the ceiling. */
const HISTORY_BATCH = 10;
const HISTORY_PAGE = 50;
/** 500 commits by one person on one branch in one range is beyond any real month. */
const HISTORY_MAX_PAGES = 10;
const TIPS_MAX_PAGES = 30;
const PR_COMMITS_BATCH = 5;
const PR_COMMITS_MAX_PAGES = 5;
const SEARCH_PAGE = 25;
/** GitHub search never returns more than 1,000 results for one query. */
const SEARCH_CEILING = 1000;
const LOOKUP_BATCH = 25;
/** Repositories resolved per `RepoNames` query: each is a single node, so this is cheap. */
const RENAME_BATCH = 50;
const REPO_CONCURRENCY = 4;
/**
 * A branch whose tip was committed before the range cannot contain a commit
 * committed in it — its history only goes further back. A day of slack absorbs
 * committer clocks that run behind.
 */
const INACTIVE_TIP_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * GitHub logins: alphanumerics and hyphens — plus the underscore that
 * Enterprise Managed Users carry (`handle_shortcode`, e.g. `Rakesh-R_athma`;
 * every developer on the reference tenant). Anything else is not put in a
 * search string. The cap leaves room for the EMU suffix.
 */
export const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62})$/;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function verifyTimeBudgetMs(): number {
  const raw = Number(process.env.GITHUB_VERIFY_TIME_BUDGET_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : 120_000;
}

const COMMIT_FIELDS = `
  oid
  message
  committedDate
  authoredDate
  additions
  deletions
  parents { totalCount }
  author { name email user { login } }`;

interface CommitNode {
  oid?: string;
  message?: string;
  committedDate?: string;
  authoredDate?: string;
  additions?: number;
  deletions?: number;
  parents?: { totalCount?: number };
  author?: {
    name?: string | null;
    email?: string | null;
    user?: { login?: string } | null;
  } | null;
}

interface HistoryConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: (CommitNode | null)[];
}

interface PrNode {
  __typename?: string;
  number?: number;
  title?: string;
  state?: string;
  createdAt?: string;
  mergedAt?: string | null;
  additions?: number;
  deletions?: number;
  headRefName?: string;
  author?: { login?: string } | null;
  repository?: { nameWithOwner?: string };
  reviews?: {
    pageInfo?: { hasNextPage?: boolean };
    nodes?: ({
      databaseId?: number | null;
      state?: string;
      submittedAt?: string | null;
      author?: { __typename?: string; login?: string } | null;
    } | null)[];
  };
}

interface SearchData {
  search?: {
    issueCount?: number;
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    nodes?: (PrNode | null)[];
  };
}

type AuthorFilter = { id: string } | { emails: string[] };

interface HistorySlot {
  branch: string;
  author: AuthorFilter;
  cursor?: string;
  pages: number;
}

/** Shared stop state for one verification run: rate budget and wall clock. */
class RunState {
  halted?: { reason: UnverifiedReason; detail: string };
  rateLimitRemaining?: number;

  constructor(
    private readonly deadline: number,
    private readonly reserve: number,
  ) {}

  /** Record what one response said about the budget; halt if it is spent. */
  observe(result: { rateLimitedUntil?: Date; rateLimit?: GithubRateLimit }) {
    if (result.rateLimit) {
      this.rateLimitRemaining = result.rateLimit.remaining;
    }
    const budget = evaluateBudget(result, this.reserve);
    if (budget.exhausted && !this.halted) {
      this.halted = budget.reserved
        ? {
            reason: 'budget_reserved',
            detail: `Stopped with ${this.rateLimitRemaining ?? '?'} GraphQL points left, to keep the reserve (GITHUB_BACKFILL_RATE_RESERVE) for scheduled collection. Resets ${budget.resumeAt?.toISOString() ?? 'within the hour'}.`,
          }
        : {
            reason: 'rate_limited',
            detail: `GitHub rate-limited the token until ${budget.resumeAt?.toISOString() ?? 'later'}.`,
          };
    }
  }

  /** True when the run must not start another call. */
  stopped(): boolean {
    if (!this.halted && Date.now() > this.deadline) {
      this.halted = {
        reason: 'time_budget',
        detail:
          'The verification ran out of time (GITHUB_VERIFY_TIME_BUDGET_MS); narrow the range or the repositories and run it again.',
      };
    }
    return Boolean(this.halted);
  }
}

@Injectable()
export class GithubActivityVerifyService {
  private readonly logger = new Logger(GithubActivityVerifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly gql: GithubGraphqlClient,
  ) {}

  async verify(input: VerifyActivityInput): Promise<GithubActivitySnapshot> {
    const started = Date.now();
    const state = new RunState(started + verifyTimeBudgetMs(), rateReserve());
    const unverified: UnverifiedScope[] = [];
    const tokens = new Map<string, string>();
    const repos = await this.collectedRepos(input.tenantId);
    const tokenFor = async (repo: string): Promise<string> => {
      const connection = repos.get(repo);
      const ref = connection?.secretRef ?? '';
      if (!tokens.has(ref)) {
        tokens.set(ref, await this.secrets.resolve(input.tenantId, ref));
      }
      return tokens.get(ref) ?? '';
    };

    // One token per owner for org-wide reads (search, users).
    const owners = new Map<string, string>();
    for (const repo of repos.keys()) {
      const owner = repo.split('/')[0];
      if (owner && !owners.has(owner)) {
        owners.set(owner, repo);
      }
    }
    const anyRepo = [...repos.keys()][0];
    const orgToken = anyRepo ? await tokenFor(anyRepo) : '';

    const logins = unique(input.logins);
    const emails = unique(input.emails.map((e) => e.toLowerCase()));
    const loginSet = new Set(logins);
    const emailSet = new Set(emails);

    const { ids, unresolved } = orgToken
      ? await this.resolveUserIds(orgToken, logins, state)
      : { ids: new Map<string, string>(), unresolved: logins };

    // Search returns today's `owner/name`; SprintIQ keys rows by the name it
    // collected under. REST follows rename redirects, so a renamed repo keeps
    // collecting under its old name — map GitHub's answer back before any
    // comparison, or one PR reads as both "missing" and "not returned".
    const { toCollected, renamed } = await this.currentNames(
      repos,
      tokenFor,
      state,
    );
    const auditCheckpoint = await this.prisma.githubAuditCheckpoint.findUnique({
      where: { tenantId: input.tenantId },
      select: { checkpointAt: true },
    });

    // ---- PRs authored, and reviews given: org-wide searches ----------------
    const pullRequests = new Map<string, VerifiedPullRequest>();
    const reviews = new Map<string, VerifiedReview>();
    let prsOutside = 0;
    let reviewsOutside = 0;
    for (const login of logins) {
      if (!LOGIN_PATTERN.test(login)) {
        for (const kind of ['pull_requests', 'reviews'] as const) {
          unverified.push({
            kind,
            reason: 'unsearchable_login',
            detail: `"${login}" is not a GitHub login GitHub search accepts.`,
          });
        }
        continue;
      }
      for (const [owner, repo] of owners) {
        if (!OWNER_PATTERN.test(owner)) continue;
        const token = await tokenFor(repo);
        const prNodes = await this.search(
          token,
          `is:pr author:${login} org:${owner} created:${searchStamp(input.from)}..${searchStamp(input.to)}`,
          false,
          login,
          state,
          unverified,
          'pull_requests',
        );
        for (const node of prNodes) {
          const pr = toPull(node);
          if (!pr) continue;
          pr.repoFullName = toCollected(pr.repoFullName);
          if (!repos.has(pr.repoFullName)) {
            prsOutside += 1;
            continue;
          }
          pullRequests.set(`${pr.repoFullName}#${pr.number}`, pr);
        }

        // `updated:>=from` — a review submitted in the range updated its PR
        // in the range, so this cannot miss one; the window is applied to
        // each review's own submittedAt below.
        const reviewed = await this.search(
          token,
          `is:pr reviewed-by:${login} org:${owner} updated:>=${searchStamp(input.from)}`,
          true,
          login,
          state,
          unverified,
          'reviews',
        );
        for (const node of reviewed) {
          const current = node.repository?.nameWithOwner;
          if (!current || node.number === undefined) continue;
          const repoFullName = toCollected(current);
          const pr = `${repoFullName}#${node.number}`;
          if (node.reviews?.pageInfo?.hasNextPage) {
            unverified.push({
              kind: 'reviews',
              repoFullName,
              pullRequest: pr,
              reason: 'truncated',
              detail: `More than 50 reviews by ${login} on ${pr}; only the first 50 were read.`,
            });
          }
          for (const r of node.reviews?.nodes ?? []) {
            if (!r || r.databaseId == null || !r.submittedAt) continue;
            if ((r.state ?? '').toUpperCase() === 'PENDING') continue;
            const at = new Date(r.submittedAt);
            if (at < input.from || at > input.to) continue;
            if (!repos.has(repoFullName)) {
              reviewsOutside += 1;
              continue;
            }
            reviews.set(String(r.databaseId), {
              externalId: String(r.databaseId),
              repoFullName,
              number: String(node.number),
              reviewerLogin: r.author?.login,
              isBot: r.author?.__typename === 'Bot',
              state: (r.state ?? '').toLowerCase(),
              submittedAt: r.submittedAt,
            });
          }
        }
      }
    }

    // ---- Which repositories to read branch histories in --------------------
    let candidates: string[];
    if (input.scope === 'all') {
      candidates = [...repos.keys()];
    } else {
      const wanted = new Set<string>(input.hintRepos ?? []);
      for (const pr of pullRequests.values()) wanted.add(pr.repoFullName);
      for (const repo of await this.contributedRepos(
        orgToken,
        logins.filter((l) => ids.has(l)),
        input.from,
        input.to,
        state,
      )) {
        wanted.add(toCollected(repo));
      }
      candidates = [...wanted].filter((r) => repos.has(r));
    }
    candidates.sort();

    // ---- Commits: every live branch, plus the developer's PR commit lists --
    const commits = new Map<string, VerifiedCommit>();
    const authorFilters: AuthorFilter[] = [
      ...[...ids.values()].map((id) => ({ id })),
      ...(emails.length > 0 ? [{ emails: emailVariants(emails) }] : []),
    ];
    if (authorFilters.length === 0) {
      unverified.push({
        kind: 'commits',
        reason: 'unsearchable_login',
        detail:
          'None of this developer’s logins is a GitHub user and no git email is known, so there is nothing to look their commits up by.',
      });
    }
    const keep = (repoFullName: string, node: CommitNode) => {
      const commit = toCommit(repoFullName, node);
      if (!commit) return undefined;
      const at = new Date(commit.committedAt);
      if (at < input.from || at > input.to) return undefined;
      if (!isAttributed(commit, loginSet, emailSet)) return undefined;
      const key = `${repoFullName} ${commit.sha}`;
      const existing = commits.get(key);
      if (existing) return existing;
      commits.set(key, commit);
      return commit;
    };

    let branchesScanned = 0;
    let branchesSkippedInactive = 0;
    const scanned: string[] = [];
    await forEachBounded(candidates, REPO_CONCURRENCY, async (repoFullName) => {
      if (state.stopped()) {
        unverified.push(haltedScope(state, 'commits', repoFullName));
        return;
      }
      const token = await tokenFor(repoFullName);
      if (!token) {
        unverified.push({
          kind: 'commits',
          repoFullName,
          reason: 'no_token',
          detail: 'No token is stored for this repository’s connection.',
        });
        return;
      }
      scanned.push(repoFullName);
      const tips = await this.activeBranches(
        token,
        repoFullName,
        new Date(input.from.getTime() - INACTIVE_TIP_SLACK_MS),
        state,
        unverified,
      );
      if (tips) {
        branchesScanned += tips.active.length;
        branchesSkippedInactive += tips.skipped;
        const slots: HistorySlot[] = tips.active.flatMap((branch) =>
          authorFilters.map((author) => ({ branch, author, pages: 0 })),
        );
        await this.readHistories(
          token,
          repoFullName,
          slots,
          input.from,
          input.to,
          state,
          unverified,
          (node, branch) => {
            const c = keep(repoFullName, node);
            if (c && !c.branches.includes(branch)) c.branches.push(branch);
          },
        );
      }
      // A squash-merged or deleted head branch is unreachable from any live
      // ref, but its PR's commit list still holds the commits.
      const prNumbers = [...pullRequests.values()]
        .filter((p) => p.repoFullName === repoFullName)
        .map((p) => p.number);
      await this.readPullCommits(
        token,
        repoFullName,
        prNumbers,
        state,
        unverified,
        (node, number) => {
          const c = keep(repoFullName, node);
          const ref = `${repoFullName}#${number}`;
          if (c && !c.pullRequests.includes(ref)) c.pullRequests.push(ref);
        },
      );
    });

    const snapshot: GithubActivitySnapshot = {
      commits: [...commits.values()],
      pullRequests: [...pullRequests.values()],
      reviews: [...reviews.values()],
      unverified,
      coverage: {
        scope: input.scope,
        collectedRepos: repos.size,
        reposScanned: scanned.sort(),
        reposNotScanned: repos.size - candidates.length,
        branchesScanned,
        branchesSkippedInactive,
        pullRequestsOutsideCollectedRepos: prsOutside,
        reviewsOutsideCollectedRepos: reviewsOutside,
        loginsResolved: [...ids.keys()],
        loginsUnresolved: unresolved,
        collectedThrough: Object.fromEntries(
          [...repos.entries()].map(([repo, c]) => [
            repo,
            c.collectedThroughAt?.toISOString() ?? null,
          ]),
        ),
        renamedRepos: renamed,
        ...(auditCheckpoint
          ? {
              branchCommitsCollectedThrough:
                auditCheckpoint.checkpointAt?.toISOString() ?? null,
            }
          : {}),
        rateLimitRemaining: state.rateLimitRemaining,
        durationMs: Date.now() - started,
      },
    };
    this.logger.log(
      `activity verify tenant=${input.tenantId} repos=${scanned.length}/${repos.size} branches=${branchesScanned} ` +
        `commits=${snapshot.commits.length} prs=${snapshot.pullRequests.length} reviews=${snapshot.reviews.length} ` +
        `unverified=${unverified.length} durationMs=${snapshot.coverage.durationMs}`,
    );
    return snapshot;
  }

  /**
   * Point lookups by SHA, for records SprintIQ holds that the range query did
   * not return. Separates "GitHub has no such commit" from "it exists, just not
   * on a live branch or in one of the developer's PRs" (squash-merged, branch
   * deleted, or re-attributed).
   */
  async lookupCommits(
    tenantId: string,
    refs: { repoFullName: string; sha: string }[],
  ): Promise<CommitLookup[]> {
    const repos = await this.collectedRepos(tenantId);
    const state = new RunState(
      Date.now() + verifyTimeBudgetMs(),
      rateReserve(),
    );
    const out: CommitLookup[] = [];
    const byRepo = new Map<string, string[]>();
    for (const r of refs) {
      byRepo.set(r.repoFullName, [
        ...(byRepo.get(r.repoFullName) ?? []),
        r.sha,
      ]);
    }
    const tokens = new Map<string, string>();
    for (const [repoFullName, shas] of byRepo) {
      const ref = repos.get(repoFullName)?.secretRef ?? '';
      if (!tokens.has(ref)) {
        tokens.set(ref, await this.secrets.resolve(tenantId, ref));
      }
      const token = tokens.get(ref) ?? '';
      const [owner, name] = repoFullName.split('/');
      for (let i = 0; i < shas.length; i += LOOKUP_BATCH) {
        const chunk = shas.slice(i, i + LOOKUP_BATCH);
        const unverifiedAll = (reason: UnverifiedReason) =>
          chunk.forEach((sha) =>
            out.push({ repoFullName, sha, status: 'unverified', reason }),
          );
        if (!token) {
          unverifiedAll('no_token');
          continue;
        }
        if (state.stopped()) {
          unverifiedAll(state.halted?.reason ?? 'failed');
          continue;
        }
        const vars: Record<string, unknown> = { owner, name };
        chunk.forEach((sha, j) => (vars[`o${j}`] = sha));
        const query = `
query Lookup($owner: String!, $name: String!, ${chunk.map((_, j) => `$o${j}: GitObjectID!`).join(', ')}) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    ${chunk.map((_, j) => `c${j}: object(oid: $o${j}) { __typename ... on Commit { ${COMMIT_FIELDS} } }`).join('\n    ')}
  }
}`;
        const res = await this.gql.query<{
          repository?: Record<
            string,
            (CommitNode & { __typename?: string }) | null
          > | null;
        }>(token, query, vars);
        state.observe(res);
        if (!res.data) {
          unverifiedAll(failureReason(res));
          continue;
        }
        if (!res.data.repository) {
          unverifiedAll(
            erroredUnder(res, 'repository') ? 'failed' : 'not_found',
          );
          continue;
        }
        chunk.forEach((sha, j) => {
          if (erroredUnder(res, `repository.c${j}`)) {
            out.push({
              repoFullName,
              sha,
              status: 'unverified',
              reason: 'failed',
            });
            return;
          }
          const node = res.data?.repository?.[`c${j}`];
          const commit = node ? toCommit(repoFullName, node) : undefined;
          out.push(
            commit
              ? { repoFullName, sha, status: 'found', commit }
              : { repoFullName, sha, status: 'not_found' },
          );
        });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ reads

  private async collectedRepos(
    tenantId: string,
  ): Promise<Map<string, Connection>> {
    const connections = await this.prisma.connection.findMany({
      where: { tenantId, sourceSystem: 'github', status: 'active' },
    });
    const byRepo = new Map<string, Connection>();
    for (const c of connections) {
      const repo = (c.config as { repoFullName?: string } | null)?.repoFullName;
      if (repo) byRepo.set(repo, c);
    }
    return byRepo;
  }

  /**
   * GitHub's current `owner/name` for every collected repo, as a function from
   * any name GitHub may report back to the name SprintIQ collected under.
   * Case-insensitive, as GitHub names are. One query per 50 repos, per token.
   * A repo GitHub cannot resolve keeps its own name (its branch read reports
   * `not_found` separately); a failed batch just means no mapping, never data.
   */
  private async currentNames(
    repos: Map<string, Connection>,
    tokenFor: (repo: string) => Promise<string>,
    state: RunState,
  ): Promise<{
    toCollected: (name: string) => string;
    renamed: { collected: string; current: string }[];
  }> {
    const map = new Map<string, string>();
    const renamed: { collected: string; current: string }[] = [];
    for (const repo of repos.keys()) map.set(repo.toLowerCase(), repo);

    const byToken = new Map<string, string[]>();
    for (const repo of repos.keys()) {
      const token = await tokenFor(repo);
      if (token) byToken.set(token, [...(byToken.get(token) ?? []), repo]);
    }
    for (const [token, names] of byToken) {
      for (let i = 0; i < names.length; i += RENAME_BATCH) {
        if (state.stopped()) break;
        const chunk = names.slice(i, i + RENAME_BATCH);
        const vars: Record<string, unknown> = {};
        chunk.forEach((repo, j) => {
          const [owner, name] = repo.split('/');
          vars[`o${j}`] = owner;
          vars[`n${j}`] = name;
        });
        const res = await this.gql.query<
          Record<string, { nameWithOwner?: string } | null>
        >(
          token,
          `
query RepoNames(${chunk.map((_, j) => `$o${j}: String!, $n${j}: String!`).join(', ')}) {
  rateLimit { cost remaining resetAt }
  ${chunk.map((_, j) => `r${j}: repository(owner: $o${j}, name: $n${j}) { nameWithOwner }`).join('\n  ')}
}`,
          vars,
        );
        state.observe(res);
        chunk.forEach((collected, j) => {
          const current = res.data?.[`r${j}`]?.nameWithOwner;
          if (!current || current === collected) return;
          map.set(current.toLowerCase(), collected);
          renamed.push({ collected, current });
        });
      }
    }
    return {
      toCollected: (name) => map.get(name.toLowerCase()) ?? name,
      renamed,
    };
  }

  private async resolveUserIds(
    token: string,
    logins: string[],
    state: RunState,
  ): Promise<{ ids: Map<string, string>; unresolved: string[] }> {
    const ids = new Map<string, string>();
    if (logins.length === 0) return { ids, unresolved: [] };
    const vars: Record<string, unknown> = {};
    logins.forEach((l, i) => (vars[`l${i}`] = l));
    const query = `
query Users(${logins.map((_, i) => `$l${i}: String!`).join(', ')}) {
  rateLimit { cost remaining resetAt }
  ${logins.map((_, i) => `u${i}: user(login: $l${i}) { id login }`).join('\n  ')}
}`;
    const res = await this.gql.query<Record<string, { id?: string } | null>>(
      token,
      query,
      vars,
    );
    state.observe(res);
    logins.forEach((login, i) => {
      const id = res.data?.[`u${i}`]?.id;
      if (id) ids.set(login, id);
    });
    return { ids, unresolved: logins.filter((l) => !ids.has(l)) };
  }

  /**
   * Repos where GitHub itself records this developer's contributions in the
   * range. Default-branch commits and PRs only — GitHub's own definition — so
   * this widens the scan, it never bounds it; `hintRepos` and the PR search
   * cover the rest.
   */
  private async contributedRepos(
    token: string,
    logins: string[],
    from: Date,
    to: Date,
    state: RunState,
  ): Promise<string[]> {
    const repos = new Set<string>();
    for (const login of logins) {
      if (!token || state.stopped()) break;
      const res = await this.gql.query<{
        user?: {
          contributionsCollection?: Record<
            string,
            { repository?: { nameWithOwner?: string } }[] | undefined
          >;
        } | null;
      }>(
        token,
        `
query Contributed($login: String!, $from: DateTime!, $to: DateTime!) {
  rateLimit { cost remaining resetAt }
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      commitContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner } }
      pullRequestContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner } }
    }
  }
}`,
        { login, from: from.toISOString(), to: to.toISOString() },
      );
      state.observe(res);
      const cc = res.data?.user?.contributionsCollection ?? {};
      for (const list of Object.values(cc)) {
        for (const item of list ?? []) {
          if (item.repository?.nameWithOwner) {
            repos.add(item.repository.nameWithOwner);
          }
        }
      }
    }
    return [...repos];
  }

  private async search(
    token: string,
    q: string,
    withReviews: boolean,
    login: string,
    state: RunState,
    unverified: UnverifiedScope[],
    kind: 'pull_requests' | 'reviews',
  ): Promise<PrNode[]> {
    const nodes: PrNode[] = [];
    const reviewFields = withReviews
      ? `reviews(first: 50, author: $login) { pageInfo { hasNextPage } nodes { databaseId state submittedAt author { __typename login } } }`
      : `title state createdAt mergedAt additions deletions headRefName author { login }`;
    const query = `
query Search($q: String!, $after: String${withReviews ? ', $login: String!' : ''}) {
  rateLimit { cost remaining resetAt }
  search(query: $q, type: ISSUE, first: ${SEARCH_PAGE}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { __typename ... on PullRequest { number repository { nameWithOwner } ${reviewFields} } }
  }
}`;
    let after: string | undefined;
    for (;;) {
      if (state.stopped()) {
        unverified.push(haltedScope(state, kind));
        return nodes;
      }
      const res = await this.gql.query<SearchData>(token, query, {
        q,
        after,
        ...(withReviews ? { login } : {}),
      });
      state.observe(res);
      const search = res.data?.search;
      if (!search || erroredUnder(res, 'search')) {
        unverified.push({
          kind,
          reason: failureReason(res),
          detail: `GitHub search "${q}" did not complete.`,
        });
        return nodes;
      }
      if ((search.issueCount ?? 0) > SEARCH_CEILING) {
        unverified.push({
          kind,
          reason: 'truncated',
          detail: `GitHub search "${q}" matched ${search.issueCount} results; it returns at most ${SEARCH_CEILING}.`,
        });
      }
      for (const n of search.nodes ?? []) {
        if (n?.__typename === 'PullRequest') nodes.push(n);
      }
      if (!search.pageInfo?.hasNextPage || nodes.length >= SEARCH_CEILING) {
        return nodes;
      }
      after = search.pageInfo.endCursor ?? undefined;
    }
  }

  private async activeBranches(
    token: string,
    repoFullName: string,
    tipFloor: Date,
    state: RunState,
    unverified: UnverifiedScope[],
  ): Promise<{ active: string[]; skipped: number } | undefined> {
    const [owner, name] = repoFullName.split('/');
    const active: string[] = [];
    let skipped = 0;
    let after: string | undefined;
    for (let page = 0; page < TIPS_MAX_PAGES; page++) {
      if (state.stopped()) {
        unverified.push(haltedScope(state, 'commits', repoFullName));
        return undefined;
      }
      const res = await this.gql.query<{
        repository?: {
          refs?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: ({
              name?: string;
              target?: { __typename?: string; committedDate?: string } | null;
            } | null)[];
          } | null;
        } | null;
      }>(
        token,
        `
query Tips($owner: String!, $name: String!, $after: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { name target { __typename ... on Commit { committedDate } } }
    }
  }
}`,
        { owner, name, after },
      );
      state.observe(res);
      if (!res.data || erroredUnder(res, 'repository')) {
        unverified.push({
          kind: 'commits',
          repoFullName,
          reason: res.data ? 'failed' : failureReason(res),
          detail: 'Could not list this repository’s branches.',
        });
        return undefined;
      }
      if (!res.data.repository) {
        unverified.push({
          kind: 'commits',
          repoFullName,
          reason: 'not_found',
          detail:
            'GitHub returned no such repository for this token (renamed, deleted, or no access).',
        });
        return undefined;
      }
      const refs = res.data.repository.refs;
      for (const node of refs?.nodes ?? []) {
        if (!node?.name) continue;
        const tipAt = node.target?.committedDate
          ? new Date(node.target.committedDate)
          : undefined;
        // An unreadable tip is scanned, not skipped: skipping is only safe
        // when the tip PROVES the branch has nothing in the range.
        if (tipAt && tipAt < tipFloor) skipped += 1;
        else active.push(node.name);
      }
      if (!refs?.pageInfo?.hasNextPage) {
        return { active, skipped };
      }
      after = refs.pageInfo.endCursor ?? undefined;
    }
    unverified.push({
      kind: 'commits',
      repoFullName,
      reason: 'truncated',
      detail: `More than ${TIPS_MAX_PAGES * 100} branches; only the first ${TIPS_MAX_PAGES * 100} were read.`,
    });
    return { active, skipped };
  }

  private async readHistories(
    token: string,
    repoFullName: string,
    initial: HistorySlot[],
    from: Date,
    to: Date,
    state: RunState,
    unverified: UnverifiedScope[],
    onCommit: (node: CommitNode, branch: string) => void,
  ): Promise<void> {
    const [owner, name] = repoFullName.split('/');
    const queue = [...initial];
    let batch = HISTORY_BATCH;
    const dropBranch = (
      slot: HistorySlot,
      reason: UnverifiedReason,
      detail: string,
    ) => {
      if (
        !unverified.some(
          (u) =>
            u.kind === 'commits' &&
            u.repoFullName === repoFullName &&
            u.branch === slot.branch,
        )
      ) {
        unverified.push({
          kind: 'commits',
          repoFullName,
          branch: slot.branch,
          reason,
          detail,
        });
      }
    };

    while (queue.length > 0) {
      if (state.stopped()) {
        unverified.push(haltedScope(state, 'commits', repoFullName));
        return;
      }
      const chunk = queue.slice(0, batch);
      const vars: Record<string, unknown> = {
        owner,
        name,
        since: from.toISOString(),
        until: to.toISOString(),
      };
      chunk.forEach((slot, i) => {
        vars[`q${i}`] = `refs/heads/${slot.branch}`;
        vars[`a${i}`] = slot.author;
        vars[`c${i}`] = slot.cursor ?? null;
      });
      const query = `
query Histories($owner: String!, $name: String!, $since: GitTimestamp!, $until: GitTimestamp!, ${chunk
        .map((_, i) => `$q${i}: String!, $a${i}: CommitAuthor!, $c${i}: String`)
        .join(', ')}) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    ${chunk
      .map(
        (_, i) =>
          `h${i}: ref(qualifiedName: $q${i}) { target { ... on Commit { history(first: ${HISTORY_PAGE}, since: $since, until: $until, author: $a${i}, after: $c${i}) { pageInfo { hasNextPage endCursor } nodes { ${COMMIT_FIELDS} } } } } }`,
      )
      .join('\n    ')}
  }
}`;
      const res = await this.gql.query<{
        repository?: Record<
          string,
          { target?: { history?: HistoryConnection } | null } | null
        > | null;
      }>(token, query, vars);
      state.observe(res);

      if (res.tooComplex) {
        if (batch > 1) {
          batch = Math.max(1, Math.floor(batch / 2));
          continue;
        }
        dropBranch(
          queue.shift() as HistorySlot,
          'too_complex',
          'GitHub could not serve this branch’s history in time.',
        );
        continue;
      }
      if (!res.data) {
        if (res.rateLimitedUntil) continue; // `observe` halted the run; the loop head reports it.
        chunk.forEach((slot) =>
          dropBranch(
            slot,
            failureReason(res),
            'Reading this branch’s history failed.',
          ),
        );
        queue.splice(0, chunk.length);
        continue;
      }
      queue.splice(0, chunk.length);
      chunk.forEach((slot, i) => {
        if (
          erroredUnder(res, `repository.h${i}`) ||
          erroredUnder(res, 'repository')
        ) {
          dropBranch(
            slot,
            'failed',
            'GitHub returned an error for this branch’s history.',
          );
          return;
        }
        const ref = res.data?.repository?.[`h${i}`];
        // Deleted between listing and reading: nothing left to verify on it.
        const history = ref?.target?.history;
        if (!history) return;
        for (const node of history.nodes ?? []) {
          if (node) onCommit(node, slot.branch);
        }
        if (history.pageInfo?.hasNextPage) {
          if (slot.pages + 1 < HISTORY_MAX_PAGES) {
            queue.push({
              ...slot,
              cursor: history.pageInfo.endCursor ?? undefined,
              pages: slot.pages + 1,
            });
          } else {
            dropBranch(
              slot,
              'truncated',
              `More than ${HISTORY_PAGE * HISTORY_MAX_PAGES} of this developer’s commits on this branch in the range; the rest were not read.`,
            );
          }
        }
      });
    }
  }

  private async readPullCommits(
    token: string,
    repoFullName: string,
    numbers: string[],
    state: RunState,
    unverified: UnverifiedScope[],
    onCommit: (node: CommitNode, number: string) => void,
  ): Promise<void> {
    const [owner, name] = repoFullName.split('/');
    let queue = numbers.map((n) => ({
      number: n,
      cursor: undefined as string | undefined,
      pages: 0,
    }));
    while (queue.length > 0) {
      if (state.stopped()) {
        unverified.push(haltedScope(state, 'commits', repoFullName));
        return;
      }
      const chunk = queue.slice(0, PR_COMMITS_BATCH);
      queue = queue.slice(chunk.length);
      const vars: Record<string, unknown> = { owner, name };
      chunk.forEach((slot, i) => {
        vars[`n${i}`] = Number(slot.number);
        vars[`c${i}`] = slot.cursor ?? null;
      });
      const query = `
query PullCommits($owner: String!, $name: String!, ${chunk.map((_, i) => `$n${i}: Int!, $c${i}: String`).join(', ')}) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    ${chunk
      .map(
        (_, i) =>
          `p${i}: pullRequest(number: $n${i}) { commits(first: 100, after: $c${i}) { pageInfo { hasNextPage endCursor } nodes { commit { ${COMMIT_FIELDS} } } } }`,
      )
      .join('\n    ')}
  }
}`;
      const res = await this.gql.query<{
        repository?: Record<
          string,
          {
            commits?: {
              pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
              nodes?: ({ commit?: CommitNode } | null)[];
            };
          } | null
        > | null;
      }>(token, query, vars);
      state.observe(res);
      chunk.forEach((slot, i) => {
        const pr = `${repoFullName}#${slot.number}`;
        const commitsConn = res.data?.repository?.[`p${i}`]?.commits;
        if (!commitsConn || erroredUnder(res, `repository.p${i}`)) {
          unverified.push({
            kind: 'commits',
            repoFullName,
            pullRequest: pr,
            reason: res.data ? 'failed' : failureReason(res),
            detail: 'Could not read this pull request’s commit list.',
          });
          return;
        }
        for (const node of commitsConn.nodes ?? []) {
          if (node?.commit) onCommit(node.commit, slot.number);
        }
        if (commitsConn.pageInfo?.hasNextPage) {
          if (slot.pages + 1 < PR_COMMITS_MAX_PAGES) {
            queue.push({
              number: slot.number,
              cursor: commitsConn.pageInfo.endCursor ?? undefined,
              pages: slot.pages + 1,
            });
          } else {
            unverified.push({
              kind: 'commits',
              repoFullName,
              pullRequest: pr,
              reason: 'truncated',
              detail: `More than ${PR_COMMITS_MAX_PAGES * 100} commits on this pull request; the rest were not read.`,
            });
          }
        }
      });
    }
  }
}

// ---------------------------------------------------------------- helpers

function unique(values: string[]): string[] {
  return [...new Set(values.filter((v) => v && v.trim().length > 0))];
}

/** The emails filter is matched as given; send both spellings we know of. */
function emailVariants(emails: string[]): string[] {
  return unique(emails.flatMap((e) => [e, e.toLowerCase()]));
}

/** `YYYY-MM-DDTHH:MM:SSZ` — GitHub search rejects milliseconds. */
export function searchStamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The DB's attribution rule, applied to GitHub's answer (`authorPredicate` in
 * CodeService): an account login is authoritative; an email only counts when
 * GitHub resolved the commit to no account at all.
 */
export function isAttributed(
  commit: Pick<VerifiedCommit, 'authorLogin' | 'authorEmail'>,
  logins: Set<string>,
  emails: Set<string>,
): boolean {
  if (commit.authorLogin) {
    return logins.has(commit.authorLogin);
  }
  return Boolean(
    commit.authorEmail && emails.has(commit.authorEmail.toLowerCase()),
  );
}

function toCommit(
  repoFullName: string,
  node: CommitNode,
): VerifiedCommit | undefined {
  if (!node.oid || !node.committedDate) return undefined;
  return {
    repoFullName,
    sha: node.oid,
    message: (node.message ?? '').split('\n')[0],
    authorLogin: node.author?.user?.login ?? undefined,
    authorName: node.author?.name ?? undefined,
    authorEmail: node.author?.email ?? undefined,
    authoredAt: node.authoredDate ?? node.committedDate,
    committedAt: node.committedDate,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    parentCount: node.parents?.totalCount ?? 1,
    branches: [],
    pullRequests: [],
  };
}

function toPull(node: PrNode): VerifiedPullRequest | undefined {
  const repoFullName = node.repository?.nameWithOwner;
  if (!repoFullName || node.number === undefined || !node.createdAt) {
    return undefined;
  }
  const raw = (node.state ?? '').toLowerCase();
  return {
    repoFullName,
    number: String(node.number),
    title: node.title ?? '',
    state: raw === 'merged' ? 'merged' : raw === 'open' ? 'open' : 'closed',
    authorLogin: node.author?.login,
    openedAt: node.createdAt,
    mergedAt: node.mergedAt ?? undefined,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    headRef: node.headRefName,
  };
}

function erroredUnder<T>(result: GraphqlResult<T>, path: string): boolean {
  for (const errored of result.erroredPaths) {
    if (errored === path || errored.startsWith(`${path}.`)) return true;
  }
  return false;
}

function failureReason<T>(result: GraphqlResult<T>): UnverifiedReason {
  if (result.rateLimitedUntil) return 'rate_limited';
  if (result.tooComplex) return 'too_complex';
  return 'failed';
}

function haltedScope(
  state: RunState,
  kind: UnverifiedScope['kind'],
  repoFullName?: string,
): UnverifiedScope {
  return {
    kind,
    ...(repoFullName ? { repoFullName } : {}),
    reason: state.halted?.reason ?? 'failed',
    detail: state.halted?.detail ?? 'The verification stopped early.',
  };
}
