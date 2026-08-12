import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Commit, PrReview, PullRequest } from '@prisma/client';
import {
  CodeCommitPayload,
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

/** Filters for commit activity reads (project/developer activity boards). */
export interface CommitFilters {
  repos?: string[];
  authorLogin?: string;
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

  /** PRs authored by one developer within a window (developer activity board). */
  listPullRequestsByAuthor(
    tenantId: string,
    authorLogin: string,
    from?: Date,
    to?: Date,
  ): Promise<PullRequest[]> {
    return this.prisma.pullRequest.findMany({
      where: {
        tenantId,
        authorLogin,
        openedAt: {
          ...(from ? { gte: from } : {}),
          ...(to ? { lte: to } : {}),
        },
      },
      orderBy: { openedAt: 'desc' },
      take: 500,
    });
  }

  /** Commit activity read (project/developer activity boards). */
  listCommits(tenantId: string, filters: CommitFilters): Promise<Commit[]> {
    return this.prisma.commit.findMany({
      where: {
        tenantId,
        ...(filters.repos && filters.repos.length > 0
          ? { repoFullName: { in: filters.repos } }
          : {}),
        ...(filters.authorLogin ? { authorLogin: filters.authorLogin } : {}),
        // Windows by committer date (when the commit actually landed), not
        // author date — the two diverge on a rebase/cherry-pick/amend.
        committedAt: {
          ...(filters.from ? { gte: filters.from } : {}),
          ...(filters.to ? { lte: filters.to } : {}),
        },
      },
      orderBy: { committedAt: 'desc' },
      take: 2000,
    });
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
