import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Commit, PrReview, Prisma, PullRequest } from '@prisma/client';
import {
  CodeCommitBranchObservedPayload,
  CodeCommitPayload,
  CodeCopilotReportDayPayload,
  CodeCopilotSeatsPayload,
  CodeCopilotUsagePayload,
  CodePullRequestPayload,
} from '../../common/events/contracts';
import {
  CODE_PR_EVENT_TYPES,
  EventTypes,
} from '../../common/events/event-types';
import { DomainEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus';
import { newId } from '../../common/id';
import { PrismaService } from '../../database/prisma.service';

/**
 * Ceiling on a single commit-activity read.
 *
 * A bound is still needed — these rows are loaded into memory and summed — but
 * the old 2,000 was low enough that an ordinary month of work on one mid-sized
 * org approached it. Raised, and paired with an explicit `truncated` signal so
 * that reaching it is reported rather than quietly changing the answer. If a
 * tenant starts tripping this regularly the real fix is aggregating in SQL
 * instead of loading rows at all.
 */
const COMMIT_READ_LIMIT = 20_000;

/** Filters for commit activity reads (project/developer activity boards). */
export interface CommitFilters {
  repos?: string[];
  /**
   * Every login the developer commits under. A list rather than one login
   * because a person can appear under several source accounts, and because a
   * commit GitHub could not attribute carries no login at all — see
   * `authorEmails`, and `DeveloperIdentityService` for how the set is derived.
   */
  authorLogins?: string[];
  /**
   * Git author emails belonging to the same developer. Matched only against
   * commits with NO login: where GitHub resolved an account, that account is
   * authoritative, and matching on email as well would let a shared address
   * pull in another person's attributed commits.
   */
  authorEmails?: string[];
  from?: Date;
  to?: Date;
}

/**
 * BC-4 Source Control (Git domain). Consumes code.pull_request.* events and
 * upserts PR facts; exposes reads for metrics. PR timestamps drive PR/review
 * metrics (docs/features/METRICS.md).
 */
@Injectable()
export class CodeService implements OnModuleInit {
  private readonly logger = new Logger(CodeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {}

  onModuleInit(): void {
    for (const type of CODE_PR_EVENT_TYPES) {
      this.eventBus.subscribe<CodePullRequestPayload>(type, (e) =>
        this.handlePullRequest(e),
      );
    }
    this.eventBus.subscribe<CodeCommitPayload>(
      EventTypes.CODE_COMMIT_PUSHED,
      (e) => this.handleCommit(e),
    );
    this.eventBus.subscribe<CodeCommitBranchObservedPayload>(
      EventTypes.CODE_COMMIT_BRANCH_OBSERVED,
      (e) => this.handleBranchObserved(e),
    );
    this.eventBus.subscribe<CodeCopilotUsagePayload>(
      EventTypes.CODE_COPILOT_USAGE_REPORTED,
      (e) => this.handleCopilotUsage(e),
    );
    this.eventBus.subscribe<CodeCopilotReportDayPayload>(
      EventTypes.CODE_COPILOT_REPORT_DAY_COLLECTED,
      (e) => this.handleCopilotReportDay(e),
    );
    this.eventBus.subscribe<CodeCopilotSeatsPayload>(
      EventTypes.CODE_COPILOT_SEATS_OBSERVED,
      (e) => this.handleCopilotSeats(e),
    );
  }

  /**
   * One row per commit per branch (branch tracking, 2026-10-19). Create once;
   * a later observation never moves `firstSeenAt` later, an earlier one
   * (a replayed range) moves it back. Two statements rather than a read-then-
   * write, so concurrent observations of the same link cannot race.
   */
  private async handleBranchObserved(
    event: DomainEvent<CodeCommitBranchObservedPayload>,
  ): Promise<void> {
    const p = event.payload;
    const seenAt = new Date(p.observedAt);
    const key = {
      tenantId: event.tenantId,
      repoFullName: p.repoFullName,
      branch: p.branch,
      sha: p.sha,
    };
    await this.prisma.commitBranch.upsert({
      where: { tenantId_repoFullName_branch_sha: key },
      create: { id: newId(), ...key, firstSeenAt: seenAt },
      update: {},
    });
    await this.prisma.commitBranch.updateMany({
      where: { ...key, firstSeenAt: { gt: seenAt } },
      data: { firstSeenAt: seenAt },
    });
  }

  private async handleCommit(
    event: DomainEvent<CodeCommitPayload>,
  ): Promise<void> {
    const c = event.payload;
    const fields = {
      connectionId: event.connectionId ?? '',
      message: c.message,
      authorLogin: c.authorLogin ?? null,
      authorName: c.authorName ?? null,
      authorEmail: c.authorEmail ?? null,
      authoredAt: new Date(c.authoredAt),
      committedAt: c.committedAt ? new Date(c.committedAt) : null,
      additions: c.additions ?? 0,
      deletions: c.deletions ?? 0,
      filesChanged: c.filesChanged ?? 0,
      // Only ever written when the event carries one: a payload without it (a
      // push webhook, or an older transport) must leave a known value alone
      // rather than nulling it, since null reads as "unknown" downstream.
      ...(c.parentCount !== undefined ? { parentCount: c.parentCount } : {}),
    };
    await this.prisma.commit.upsert({
      where: {
        tenantId_repoFullName_sha: {
          tenantId: event.tenantId,
          repoFullName: c.repoFullName,
          sha: c.sha,
        },
      },
      create: {
        id: newId(),
        tenantId: event.tenantId,
        repoFullName: c.repoFullName,
        sha: c.sha,
        ...fields,
      },
      update: fields,
    });
    this.logger.debug(`upserted commit ${c.repoFullName}@${c.sha.slice(0, 7)}`);
  }

  private async handlePullRequest(
    event: DomainEvent<CodePullRequestPayload>,
  ): Promise<void> {
    const p = event.payload;
    const fields = {
      connectionId: event.connectionId ?? '',
      title: p.title,
      branch: p.branch,
      // Only ever written when the event carries one. A payload without it
      // (a PR collected before head SHAs existed, or a transport that does
      // not supply one) must leave a previously-stored sha alone rather than
      // nulling it — the completeness anti-join reads absence as "unknown",
      // so erasing a known sha would silently retire a real finding.
      ...(p.headSha ? { headSha: p.headSha } : {}),
      baseBranch: p.baseBranch ?? null,
      state: p.state,
      authorLogin: p.authorLogin ?? null,
      additions: p.additions ?? 0,
      deletions: p.deletions ?? 0,
      changedFiles: p.changedFiles ?? 0,
      openedAt: toDate(p.openedAt),
      mergedAt: toDate(p.mergedAt),
    };

    // Review-derived fields follow the reviews themselves: an event that
    // didn't collect reviews leaves them alone rather than nulling a timeline
    // that cost an API call to build. Same rule as `commitMessages` below.
    const reviewFields = p.reviews
      ? {
          firstReviewAt: toDate(p.firstReviewAt) ?? null,
          approvedAt: toDate(p.approvedAt) ?? null,
          // Stamped even for an empty timeline: "we asked and there were none"
          // is an answer, and it's the only thing separating that from
          // "we never asked".
          reviewsFetchedAt: new Date(),
        }
      : {};
    const mergedByField =
      p.mergedBy === undefined ? {} : { mergedBy: p.mergedBy };

    // Commit subjects cost a dedicated API call to collect, and they are one of
    // the three Jira-key sources correlation matches on. An event that doesn't
    // carry them must therefore leave what's already stored alone — writing []
    // would silently un-correlate the PR and drop linkage coverage, with a
    // re-fetch the only way back.
    const commitMessages = p.commitMessages?.length
      ? p.commitMessages
      : undefined;

    await this.prisma.pullRequest.upsert({
      where: {
        tenantId_repoFullName_externalNumber: {
          tenantId: event.tenantId,
          repoFullName: p.repoFullName,
          externalNumber: p.externalNumber,
        },
      },
      create: {
        id: newId(),
        tenantId: event.tenantId,
        repoFullName: p.repoFullName,
        externalNumber: p.externalNumber,
        commitMessages: commitMessages ?? [],
        ...fields,
        ...reviewFields,
        ...mergedByField,
      },
      update: {
        ...fields,
        ...reviewFields,
        ...mergedByField,
        ...(commitMessages ? { commitMessages } : {}),
      },
    });

    await this.recordReviews(event, p);

    this.logger.debug(
      `upserted PR ${p.repoFullName}#${p.externalNumber} (${p.state})`,
    );
  }

  /**
   * Appends the PR's review timeline (`pr_review`).
   *
   * `createMany({ skipDuplicates })` on the (tenant, externalId) unique key
   * makes this safe to replay: a backfill re-walk and a later incremental poll
   * of the same PR both deliver the same review ids and converge on one row
   * each. Duplicating them would inflate `reviewer_load` and every count in
   * METRICS.md §3 — the same failure `issue_status_history` guards against.
   *
   * Reviews are immutable once submitted, so there is nothing to update.
   */
  private async recordReviews(
    event: DomainEvent<CodePullRequestPayload>,
    p: CodePullRequestPayload,
  ): Promise<void> {
    if (!p.reviews?.length) {
      return;
    }
    await this.prisma.prReview.createMany({
      data: p.reviews.map((r) => ({
        id: newId(),
        tenantId: event.tenantId,
        connectionId: event.connectionId ?? '',
        repoFullName: p.repoFullName,
        externalNumber: p.externalNumber,
        externalId: r.externalId,
        reviewerLogin: r.reviewerLogin ?? null,
        isBot: r.isBot,
        state: r.state,
        hasBody: r.hasBody,
        commentCount: r.commentCount ?? 0,
        commentsCounted: r.commentsCounted ?? false,
        submittedAt: new Date(r.submittedAt),
      })),
      skipDuplicates: true,
    });
  }

  /** Merged PRs with both open + merge timestamps — input for PR cycle time. */
  listMergedPullRequests(
    tenantId: string,
    repoFullName: string,
  ): Promise<PullRequest[]> {
    return this.prisma.pullRequest.findMany({
      where: {
        tenantId,
        repoFullName,
        state: 'merged',
        mergedAt: { not: null },
        openedAt: { not: null },
      },
    });
  }

  /** Merged PRs in a repo scope, with optional merge-time window. */
  listMergedPullRequestsForRepos(
    tenantId: string,
    repos: string[],
    from?: Date,
    to?: Date,
  ): Promise<PullRequest[]> {
    if (repos.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.pullRequest.findMany({
      where: {
        tenantId,
        repoFullName: { in: repos },
        state: 'merged',
        mergedAt: {
          not: null,
          ...(from ? { gte: from } : {}),
          ...(to ? { lte: to } : {}),
        },
        openedAt: { not: null },
      },
    });
  }

  /** Batch variant for the dashboard scope system: N repos, optional window. */
  listPullRequestsForRepos(
    tenantId: string,
    repos: string[],
    from?: Date,
    to?: Date,
  ): Promise<PullRequest[]> {
    if (repos.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.pullRequest.findMany({
      where: {
        tenantId,
        repoFullName: { in: repos },
        mergedAt: {
          not: null,
          ...(from ? { gte: from } : {}),
          ...(to ? { lte: to } : {}),
        },
      },
    });
  }

  /** Dashboard scope read: all merged PRs for the selected repos/time window. */
  async listDashboardPullRequests(
    tenantId: string,
    repos: string[],
    from?: Date,
    to?: Date,
  ): Promise<PullRequest[]> {
    return this.listPullRequestsForRepos(tenantId, repos, from, to);
  }

  /**
   * Reviews on the given PRs ("<repoFullName>#<number>" refs), for the Review
   * Quality metrics. Windowed by the PRs passed in rather than by review date,
   * so a review submitted just outside the window still counts toward the PR
   * it belongs to — otherwise a PR could show as unreviewed purely because its
   * review landed a day before the range started.
   */
  async listReviewsForPullRequests(
    tenantId: string,
    prs: { repoFullName: string; externalNumber: string }[],
  ): Promise<PrReview[]> {
    if (prs.length === 0) {
      return [];
    }
    const byRepo = new Map<string, string[]>();
    for (const pr of prs) {
      byRepo.set(pr.repoFullName, [
        ...(byRepo.get(pr.repoFullName) ?? []),
        pr.externalNumber,
      ]);
    }
    return this.prisma.prReview.findMany({
      where: {
        tenantId,
        OR: [...byRepo.entries()].map(([repoFullName, numbers]) => ({
          repoFullName,
          externalNumber: { in: numbers },
        })),
      },
    });
  }

  /** Pull requests addressed by correlation refs: "<repoFullName>#<number>". */
  listPullRequestsByRefs(
    tenantId: string,
    refs: string[],
    from?: Date,
    to?: Date,
  ): Promise<PullRequest[]> {
    if (refs.length === 0) {
      return Promise.resolve([]);
    }
    const byRepo = new Map<string, string[]>();
    for (const ref of refs) {
      const parsed = parsePullRequestRef(ref);
      if (!parsed) {
        continue;
      }
      byRepo.set(parsed.repoFullName, [
        ...(byRepo.get(parsed.repoFullName) ?? []),
        parsed.externalNumber,
      ]);
    }
    if (byRepo.size === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.pullRequest.findMany({
      where: {
        tenantId,
        OR: [...byRepo.entries()].map(([repoFullName, numbers]) => ({
          repoFullName,
          externalNumber: { in: numbers },
        })),
        mergedAt: {
          not: null,
          ...(from ? { gte: from } : {}),
          ...(to ? { lte: to } : {}),
        },
      },
    });
  }

  /**
   * PRs authored by one developer within a window (developer activity board).
   * Takes every login the developer authors under — see `CommitFilters`.
   */
  listPullRequestsByAuthor(
    tenantId: string,
    authorLogins: string[],
    from?: Date,
    to?: Date,
  ): Promise<PullRequest[]> {
    if (authorLogins.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.pullRequest.findMany({
      where: {
        tenantId,
        authorLogin: { in: authorLogins },
        openedAt: {
          ...(from ? { gte: from } : {}),
          ...(to ? { lte: to } : {}),
        },
      },
      orderBy: { openedAt: 'desc' },
      take: 500,
    });
  }

  /**
   * Human reviews one developer submitted in a window — the same predicate as
   * the Developer page's "PRs reviewed" (`DeveloperActivityService
   * .developerContext`), as rows rather than a count, for activity
   * verification.
   */
  listReviewsByReviewer(
    tenantId: string,
    reviewerLogins: string[],
    from: Date,
    to: Date,
  ): Promise<PrReview[]> {
    if (reviewerLogins.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.prReview.findMany({
      where: {
        tenantId,
        isBot: false,
        reviewerLogin: { in: reviewerLogins },
        submittedAt: { gte: from, lte: to },
      },
      orderBy: { submittedAt: 'desc' },
    });
  }

  /**
   * Stored rows by identity alone — no author or date predicate. Activity
   * verification asks "do we hold this record at all", which is a different
   * question from "do we count it for this person in this range", and the
   * difference is exactly what separates a mis-attributed record from an
   * uncollected one.
   */
  async findCommitsByShas(tenantId: string, shas: string[]): Promise<Commit[]> {
    const out: Commit[] = [];
    for (const chunk of chunks([...new Set(shas)], 1000)) {
      out.push(
        ...(await this.prisma.commit.findMany({
          where: { tenantId, sha: { in: chunk } },
        })),
      );
    }
    return out;
  }

  /** See `findCommitsByShas`. */
  async findPullRequestsByNumbers(
    tenantId: string,
    refs: { repoFullName: string; externalNumber: string }[],
  ): Promise<PullRequest[]> {
    const byRepo = new Map<string, string[]>();
    for (const r of refs) {
      byRepo.set(r.repoFullName, [
        ...(byRepo.get(r.repoFullName) ?? []),
        r.externalNumber,
      ]);
    }
    if (byRepo.size === 0) return [];
    return this.prisma.pullRequest.findMany({
      where: {
        tenantId,
        OR: [...byRepo.entries()].map(([repoFullName, numbers]) => ({
          repoFullName,
          externalNumber: { in: numbers },
        })),
      },
    });
  }

  /** See `findCommitsByShas`. */
  async findReviewsByExternalIds(
    tenantId: string,
    externalIds: string[],
  ): Promise<PrReview[]> {
    const out: PrReview[] = [];
    for (const chunk of chunks([...new Set(externalIds)], 1000)) {
      out.push(
        ...(await this.prisma.prReview.findMany({
          where: { tenantId, externalId: { in: chunk } },
        })),
      );
    }
    return out;
  }

  /**
   * Commit activity read (project/developer activity boards).
   *
   * Returns whether the read hit its ceiling, because these rows are summed
   * into totals rather than paged through: a silently-truncated read reports a
   * smaller number and still presents it as the whole window. The tenant this
   * was found on sat at ~70% of the old 2,000-row cap on a 30-day window, so it
   * was months from under-reporting with nothing on screen to say so.
   */
  async listCommitsPage(
    tenantId: string,
    filters: CommitFilters,
  ): Promise<{ commits: Commit[]; truncated: boolean }> {
    const rows = await this.prisma.commit.findMany({
      where: {
        tenantId,
        ...(filters.repos && filters.repos.length > 0
          ? { repoFullName: { in: filters.repos } }
          : {}),
        ...authorPredicate(filters),
        // Windows by committer date (when the commit actually landed), not
        // author date — the two diverge on a rebase/cherry-pick/amend.
        committedAt: {
          ...(filters.from ? { gte: filters.from } : {}),
          ...(filters.to ? { lte: filters.to } : {}),
        },
      },
      orderBy: { committedAt: 'desc' },
      // One more than the ceiling: the extra row is how we KNOW there was more,
      // rather than inferring it from a count that happens to equal the limit.
      take: COMMIT_READ_LIMIT + 1,
    });
    return {
      commits: rows.slice(0, COMMIT_READ_LIMIT),
      truncated: rows.length > COMMIT_READ_LIMIT,
    };
  }

  /** Commit activity read, when the caller doesn't need the truncation signal. */
  /**
   * The branches each of these commits has been seen on (branch tracking).
   * The only reader of `code_commit_branch`, so other contexts reach branch
   * links through here rather than the table. Tenant-scoped; one query per
   * repo, each bounded by the commits asked about.
   */
  async branchesForCommits(
    tenantId: string,
    commits: { repoFullName: string; sha: string }[],
  ): Promise<{ repoFullName: string; branch: string; sha: string }[]> {
    const byRepo = new Map<string, string[]>();
    for (const c of commits) {
      byRepo.set(c.repoFullName, [
        ...(byRepo.get(c.repoFullName) ?? []),
        c.sha,
      ]);
    }
    if (byRepo.size === 0) return [];
    return this.prisma.commitBranch.findMany({
      where: {
        tenantId,
        OR: [...byRepo.entries()].map(([repoFullName, shas]) => ({
          repoFullName,
          sha: { in: shas },
        })),
      },
      select: { repoFullName: true, branch: true, sha: true },
    });
  }

  /**
   * The state of each branch's pull requests, by head branch name: merged if
   * any merged, else open if any open, else closed if any, else none. A
   * label for branch tracking — it never filters anything. Tenant-scoped.
   */
  async pullStatusByBranch(
    tenantId: string,
    branches: { repoFullName: string; branch: string }[],
  ): Promise<Map<string, 'merged' | 'open' | 'closed'>> {
    const out = new Map<string, 'merged' | 'open' | 'closed'>();
    if (branches.length === 0) return out;
    const byRepo = new Map<string, string[]>();
    for (const b of branches) {
      byRepo.set(b.repoFullName, [
        ...(byRepo.get(b.repoFullName) ?? []),
        b.branch,
      ]);
    }
    const prs = await this.prisma.pullRequest.findMany({
      where: {
        tenantId,
        OR: [...byRepo.entries()].map(([repoFullName, names]) => ({
          repoFullName,
          branch: { in: names },
        })),
      },
      select: { repoFullName: true, branch: true, state: true },
    });
    const rank = { merged: 3, open: 2, closed: 1 } as const;
    for (const pr of prs) {
      const state = pr.state as keyof typeof rank;
      if (!(state in rank)) continue;
      const k = branchKey(pr.repoFullName, pr.branch);
      const cur = out.get(k);
      if (!cur || rank[state] > rank[cur]) out.set(k, state);
    }
    return out;
  }

  async listCommits(
    tenantId: string,
    filters: CommitFilters,
  ): Promise<Commit[]> {
    return (await this.listCommitsPage(tenantId, filters)).commits;
  }

  /** Distinct commit/PR authors — the developer picker catalog. */
  async listDeveloperLogins(
    tenantId: string,
    search?: string,
  ): Promise<string[]> {
    const needle = search?.toLowerCase();
    const [commitAuthors, prAuthors] = await Promise.all([
      this.prisma.commit.findMany({
        where: { tenantId, authorLogin: { not: null } },
        distinct: ['authorLogin'],
        select: { authorLogin: true },
        take: 500,
      }),
      this.prisma.pullRequest.findMany({
        where: { tenantId, authorLogin: { not: null } },
        distinct: ['authorLogin'],
        select: { authorLogin: true },
        take: 500,
      }),
    ]);
    const logins = new Set<string>();
    for (const row of [...commitAuthors, ...prAuthors]) {
      if (row.authorLogin) {
        logins.add(row.authorLogin);
      }
    }
    return [...logins]
      .filter((l) => !needle || l.toLowerCase().includes(needle))
      .sort();
  }

  /**
   * EVERY repository known to this tenant — the scope resolver's input.
   *
   * Deliberately unpaginated, unlike `listRepos`. Scope resolution was reusing
   * the picker's first page, so a board with no explicit repo filter silently
   * measured the alphabetically-first 50 repos and presented the result as the
   * whole tenant. At the ~200 repos this product is specified for that is a
   * three-quarters truncation with nothing on screen to indicate it. A list of
   * repo names is small; the pagination existed for the picker's UI, not for
   * correctness.
   */
  async listAllRepos(tenantId: string): Promise<string[]> {
    const rows = await this.prisma.pullRequest.findMany({
      where: { tenantId },
      distinct: ['repoFullName'],
      select: { repoFullName: true },
      orderBy: { repoFullName: 'asc' },
    });
    return rows.map((r) => r.repoFullName);
  }

  /** Distinct repositories known to this tenant (catalog for pickers/explorer). */
  async listRepos(
    tenantId: string,
    search?: string,
    page = 1,
    pageSize = 50,
  ): Promise<string[]> {
    const rows = await this.prisma.pullRequest.findMany({
      where: {
        tenantId,
        ...(search
          ? { repoFullName: { contains: search, mode: 'insensitive' as const } }
          : {}),
      },
      distinct: ['repoFullName'],
      select: { repoFullName: true },
      orderBy: { repoFullName: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return rows.map((r) => r.repoFullName);
  }

  // -------------------------------------------------------------------------
  // Copilot usage (ADR-0012) — projections of GitHub's usage-metrics reports.
  // -------------------------------------------------------------------------

  /**
   * One user-day, last-wins by `collectedAt`. GitHub restates a day while it
   * finalizes it, and the collector re-reads the newest days for exactly that
   * reason; a replay of an older raw event must not overwrite a newer reading.
   */
  private async handleCopilotUsage(
    event: DomainEvent<CodeCopilotUsagePayload>,
  ): Promise<void> {
    const u = event.payload;
    const key = {
      tenantId: event.tenantId,
      org: u.org,
      day: dayDate(u.day),
      githubUserId: BigInt(u.githubUserId),
    };
    const collectedAt = new Date(u.collectedAt);
    const existing = await this.prisma.copilotUsageDay.findUnique({
      where: { tenantId_org_day_githubUserId: key },
      select: { collectedAt: true },
    });
    if (existing && existing.collectedAt > collectedAt) {
      return;
    }
    const fields = {
      connectionId: event.connectionId ?? '',
      login: u.login,
      interactions: u.interactions,
      generations: u.generations,
      acceptances: u.acceptances,
      locSuggestedAdd: u.locSuggestedAdd,
      locSuggestedDelete: u.locSuggestedDelete,
      locAdded: u.locAdded,
      locDeleted: u.locDeleted,
      usedAgent: u.usedAgent,
      usedChat: u.usedChat,
      usedCli: u.usedCli,
      usedCodingAgent: u.usedCodingAgent,
      aiCreditsUsed: u.aiCreditsUsed,
      rawEventId: event.sourceEventIds?.[0] ?? '',
      collectedAt,
    };
    await this.prisma.copilotUsageDay.upsert({
      where: { tenantId_org_day_githubUserId: key },
      create: { id: newId(), ...key, ...fields },
      update: fields,
    });
  }

  /**
   * Records that a day's report was read whole, and drops anyone a restated
   * report no longer lists — the report is the authority on who used Copilot
   * that day, so a user it stopped naming is not one to keep showing.
   */
  private async handleCopilotReportDay(
    event: DomainEvent<CodeCopilotReportDayPayload>,
  ): Promise<void> {
    const r = event.payload;
    const key = { tenantId: event.tenantId, org: r.org, day: dayDate(r.day) };
    const collectedAt = new Date(r.collectedAt);
    const existing = await this.prisma.copilotReportDay.findUnique({
      where: { tenantId_org_day: key },
      select: { collectedAt: true },
    });
    if (existing && existing.collectedAt > collectedAt) {
      return;
    }
    const fields = {
      connectionId: event.connectionId ?? '',
      userCount: r.userCount,
      rawEventId: event.sourceEventIds?.[0] ?? '',
      collectedAt,
    };
    await this.prisma.$transaction([
      this.prisma.copilotReportDay.upsert({
        where: { tenantId_org_day: key },
        create: { id: newId(), ...key, ...fields },
        update: fields,
      }),
      this.prisma.copilotUsageDay.deleteMany({
        where: {
          ...key,
          githubUserId: { notIn: r.githubUserIds.map((id) => BigInt(id)) },
        },
      }),
    ]);
  }

  /** Replaces the org's seat list whole; a stale replay is ignored. */
  private async handleCopilotSeats(
    event: DomainEvent<CodeCopilotSeatsPayload>,
  ): Promise<void> {
    const s = event.payload;
    const observedAt = new Date(s.observedAt);
    const newest = await this.prisma.copilotSeat.findFirst({
      where: { tenantId: event.tenantId, org: s.org },
      orderBy: { observedAt: 'desc' },
      select: { observedAt: true },
    });
    if (newest && newest.observedAt > observedAt) {
      return;
    }
    await this.prisma.$transaction([
      this.prisma.copilotSeat.deleteMany({
        where: { tenantId: event.tenantId, org: s.org },
      }),
      this.prisma.copilotSeat.createMany({
        data: s.seats.map((seat) => ({
          id: newId(),
          tenantId: event.tenantId,
          connectionId: event.connectionId ?? '',
          org: s.org,
          githubUserId: BigInt(seat.githubUserId),
          login: seat.login,
          assignedAt: toDate(seat.assignedAt),
          lastActivityAt: toDate(seat.lastActivityAt),
          lastActivityEditor: seat.lastActivityEditor ?? null,
          pendingCancellationDate: seat.pendingCancellationDate
            ? dayDate(seat.pendingCancellationDate.slice(0, 10))
            : null,
          observedAt,
          rawEventId: event.sourceEventIds?.[0] ?? '',
        })),
        skipDuplicates: true,
      }),
    ]);
  }

  /**
   * Per-user-day Copilot usage between two UTC report days, inclusive. Rows,
   * not sums: a developer can hold several logins, and a day used under two
   * of them is still one day — only the caller, holding the identity index,
   * can de-duplicate that.
   */
  async copilotUsageRows(
    tenantId: string,
    fromDay: string,
    toDay: string,
  ): Promise<CopilotUsageRow[]> {
    const rows = await this.prisma.copilotUsageDay.findMany({
      where: { tenantId, day: { gte: dayDate(fromDay), lte: dayDate(toDay) } },
      select: {
        login: true,
        day: true,
        interactions: true,
        generations: true,
        acceptances: true,
        locAdded: true,
      },
    });
    return rows.map((r) => ({
      login: r.login,
      day: r.day.toISOString().slice(0, 10),
      interactions: r.interactions,
      generations: r.generations,
      acceptances: r.acceptances,
      locAdded: r.locAdded,
    }));
  }

  /** Logins holding a Copilot seat in the latest snapshot; null when none was ever taken. */
  async copilotSeatLogins(tenantId: string): Promise<string[] | null> {
    const rows = await this.prisma.copilotSeat.findMany({
      where: { tenantId },
      select: { login: true },
    });
    return rows.length > 0 ? rows.map((r) => r.login) : null;
  }

  /**
   * Whether any Copilot report was ever collected for the tenant, the newest
   * report day held, and how many report days fall inside the window — the
   * freshness a board must show beside the column.
   */
  async copilotCoverage(
    tenantId: string,
    fromDay: string,
    toDay: string,
  ): Promise<CopilotCoverage> {
    const [newest, inWindow] = await Promise.all([
      this.prisma.copilotReportDay.findFirst({
        where: { tenantId },
        orderBy: { day: 'desc' },
        select: { day: true },
      }),
      this.prisma.copilotReportDay.count({
        where: {
          tenantId,
          day: { gte: dayDate(fromDay), lte: dayDate(toDay) },
        },
      }),
    ]);
    return {
      collected: newest !== null,
      coveredThrough: newest ? newest.day.toISOString().slice(0, 10) : null,
      reportDaysInWindow: inWindow,
    };
  }
}

export interface CopilotUsageRow {
  login: string;
  /** UTC report day, `YYYY-MM-DD`. */
  day: string;
  interactions: number;
  generations: number;
  acceptances: number;
  locAdded: number;
}

export interface CopilotCoverage {
  collected: boolean;
  coveredThrough: string | null;
  reportDaysInWindow: number;
}

/** A `YYYY-MM-DD` report day as the Date a `@db.Date` column stores. */
function dayDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * Author filter for commit reads: match any of the developer's logins, OR —
 * for commits GitHub could not attribute at all — any of their git emails.
 *
 * The email arm is restricted to `authorLogin: null` on purpose. A resolved
 * login is the source's own answer and outranks our inference; without the
 * guard, a shared address (a release bot, a pairing account) would drag another
 * person's properly-attributed commits onto this developer's page.
 *
 * With neither list set the predicate is empty, which reads every author — that
 * is what Project Activity wants, and what Engineering Activity must never send.
 */
function authorPredicate(filters: CommitFilters): Prisma.CommitWhereInput {
  const logins = filters.authorLogins ?? [];
  const emails = filters.authorEmails ?? [];
  if (logins.length === 0 && emails.length === 0) {
    return {};
  }
  const arms: Prisma.CommitWhereInput[] = [];
  if (logins.length > 0) {
    arms.push({ authorLogin: { in: logins } });
  }
  if (emails.length > 0) {
    arms.push({
      authorLogin: null,
      authorEmail: { in: emails, mode: 'insensitive' },
    });
  }
  return arms.length === 1 ? arms[0] : { OR: arms };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function toDate(value?: string): Date | null {
  return value ? new Date(value) : null;
}

function parsePullRequestRef(
  ref: string,
): { repoFullName: string; externalNumber: string } | null {
  const hash = ref.lastIndexOf('#');
  if (hash <= 0 || hash === ref.length - 1) {
    return null;
  }
  return {
    repoFullName: ref.slice(0, hash),
    externalNumber: ref.slice(hash + 1),
  };
}

/** Map key for one repo's branch. */
export function branchKey(repoFullName: string, branch: string): string {
  return `${repoFullName} ${branch}`;
}
