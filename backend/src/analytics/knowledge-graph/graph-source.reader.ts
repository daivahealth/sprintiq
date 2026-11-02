import { Injectable } from '@nestjs/common';
import { DeveloperIdentityService } from '../../correlation/developer-identity.service';
import { PrismaService } from '../../database/prisma.service';
import { DeveloperDirectory } from './developer-directory';
import {
  CommitRecord,
  GraphSnapshot,
  IssueLinkRecord,
  IssueRecord,
  PullRequestRecord,
  ReviewRecord,
} from './knowledge-graph.types';

/** The correlation edge the graph projects as PR –REFERENCES→ JIRA_ISSUE. */
export const PR_ISSUE_EDGE = 'pr_implements_story';

const COMMIT_SELECT = {
  id: true,
  repoFullName: true,
  sha: true,
  authoredAt: true,
  parentCount: true,
  authorLogin: true,
  authorEmail: true,
} as const;

const PR_SELECT = {
  id: true,
  repoFullName: true,
  externalNumber: true,
  title: true,
  state: true,
  openedAt: true,
  mergedAt: true,
  authorLogin: true,
} as const;

const REVIEW_SELECT = {
  id: true,
  repoFullName: true,
  externalNumber: true,
  state: true,
  submittedAt: true,
  isBot: true,
  reviewerLogin: true,
} as const;

const STORY_SELECT = {
  id: true,
  externalKey: true,
  title: true,
  status: true,
  type: true,
  assigneeLogin: true,
  assigneeName: true,
  statusCategory: true,
  resolvedAt: true,
  sourceCreatedAt: true,
} as const;

type PrRow = {
  id: string;
  repoFullName: string;
  externalNumber: string;
  title: string;
  state: string;
  openedAt: Date | null;
  mergedAt: Date | null;
  authorLogin: string | null;
};
type ReviewRow = {
  id: string;
  repoFullName: string;
  externalNumber: string;
  state: string;
  submittedAt: Date;
  isBot: boolean;
  reviewerLogin: string | null;
};
type StoryRow = {
  id: string;
  externalKey: string;
  title: string;
  status: string;
  type: string;
  assigneeLogin: string | null;
  assigneeName: string | null;
  statusCategory: string | null;
  resolvedAt: Date | null;
  sourceCreatedAt: Date | null;
};
type LinkRow = {
  fromId: string;
  toId: string;
  confidence: number;
  method: string;
};

/**
 * The knowledge graph's only door to Postgres.
 *
 * Every query is tenant-scoped. These are reads of other contexts' tables —
 * code (BC-4), planning (BC-3), correlation (BC-5) — following the existing
 * `DeveloperActivityService` precedent; they are kept behind this one class
 * so that, on service extraction, they move behind owning-context read APIs
 * without touching the graph (ANALYTICS.md §3).
 *
 * The window rule lives here and is applied identically by the full load and
 * the single-row re-reads, so a rebuild and an incremental update can never
 * disagree about what belongs in memory.
 */
@Injectable()
export class GraphSourceReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identities: DeveloperIdentityService,
  ) {}

  async directory(tenantId: string): Promise<DeveloperDirectory> {
    const [attribution, jira] = await Promise.all([
      this.identities.attributionIndex(tenantId),
      this.identities.jiraAssigneeIndex(tenantId),
    ]);
    return new DeveloperDirectory(attribution, jira);
  }

  async loadSnapshot(
    tenantId: string,
    since: Date,
    directory: DeveloperDirectory,
  ): Promise<GraphSnapshot> {
    const [commits, prs, reviews, links] = await Promise.all([
      this.prisma.commit.findMany({
        where: { tenantId, authoredAt: { gte: since } },
        select: COMMIT_SELECT,
      }),
      this.prisma.pullRequest.findMany({
        where: { tenantId, ...prWindow(since) },
        select: PR_SELECT,
      }),
      this.prisma.prReview.findMany({
        where: { tenantId, submittedAt: { gte: since } },
        select: REVIEW_SELECT,
      }),
      // No index on fromId (DATA-MODEL.md §8), so one tenant-wide read beats
      // a lookup per PR.
      this.prisma.correlationLink.findMany({
        where: { tenantId, edgeType: PR_ISSUE_EDGE },
        select: { fromId: true, toId: true, confidence: true, method: true },
      }),
    ]);

    const prRefs = new Set(
      prs.map((pr) => prRefOf(pr.repoFullName, pr.externalNumber)),
    );
    const inScopeLinks = links.filter((l) => prRefs.has(l.fromId));
    const linksByPr = groupBy(inScopeLinks, (l) => l.fromId);
    const linkedStoryIds = [...new Set(inScopeLinks.map((l) => l.toId))];
    const stories = await this.prisma.story.findMany({
      where: {
        tenantId,
        OR: [
          { id: { in: linkedStoryIds } },
          {
            AND: [
              {
                OR: [
                  { assigneeLogin: { not: null } },
                  { assigneeName: { not: null } },
                ],
              },
              issueWindow(since),
            ],
          },
        ],
      },
      select: STORY_SELECT,
    });
    const issues = new Map(
      stories.map((s) => [s.id, toIssue(s, directory)] as const),
    );
    const reviewsByPr = groupBy(reviews, (r) =>
      prRefOf(r.repoFullName, r.externalNumber),
    );
    const linkedIds = new Set(linkedStoryIds);

    return {
      commits: commits.map((c) => ({
        id: c.id,
        repoFullName: c.repoFullName,
        sha: c.sha,
        authoredAt: c.authoredAt,
        parentCount: c.parentCount,
        author: directory.commitAuthor(c),
      })),
      pullRequests: prs.map((pr) => {
        const ref = prRefOf(pr.repoFullName, pr.externalNumber);
        return toPullRequest(
          pr,
          reviewsByPr.get(ref) ?? [],
          linksByPr.get(ref) ?? [],
          issues,
          directory,
        );
      }),
      // Issues reached by assignment alone; linked ones arrive with their PR.
      issues: stories
        .filter((s) => !linkedIds.has(s.id))
        .map((s) => issues.get(s.id))
        .filter((i): i is IssueRecord => Boolean(i?.assignee)),
    };
  }

  /** The commit as stored, or null when it is gone or outside the window. */
  async findCommit(
    tenantId: string,
    repoFullName: string,
    sha: string,
    since: Date,
    directory: DeveloperDirectory,
  ): Promise<CommitRecord | null> {
    const c = await this.prisma.commit.findFirst({
      where: { tenantId, repoFullName, sha },
      select: COMMIT_SELECT,
    });
    if (!c || c.authoredAt < since) {
      return null;
    }
    return {
      id: c.id,
      repoFullName: c.repoFullName,
      sha: c.sha,
      authoredAt: c.authoredAt,
      parentCount: c.parentCount,
      author: directory.commitAuthor(c),
    };
  }

  /** The PR with its in-window reviews and issue links, or null when out of scope. */
  async findPullRequest(
    tenantId: string,
    repoFullName: string,
    externalNumber: string,
    since: Date,
    directory: DeveloperDirectory,
  ): Promise<PullRequestRecord | null> {
    const pr = await this.prisma.pullRequest.findFirst({
      where: { tenantId, repoFullName, externalNumber, ...prWindow(since) },
      select: PR_SELECT,
    });
    if (!pr) {
      return null;
    }
    const [reviews, links] = await Promise.all([
      this.prisma.prReview.findMany({
        where: {
          tenantId,
          repoFullName,
          externalNumber,
          submittedAt: { gte: since },
        },
        select: REVIEW_SELECT,
      }),
      this.prisma.correlationLink.findMany({
        where: {
          tenantId,
          edgeType: PR_ISSUE_EDGE,
          fromId: prRefOf(repoFullName, externalNumber),
        },
        select: { fromId: true, toId: true, confidence: true, method: true },
      }),
    ]);
    const stories = links.length
      ? await this.prisma.story.findMany({
          where: { tenantId, id: { in: links.map((l) => l.toId) } },
          select: STORY_SELECT,
        })
      : [];
    const issues = new Map(
      stories.map((s) => [s.id, toIssue(s, directory)] as const),
    );
    return toPullRequest(pr, reviews, links, issues, directory);
  }

  /**
   * The story as stored, or null when gone. `inWindow` says whether it
   * qualifies on its own (by assignment) under the same rule as the full load;
   * one a loaded PR references stays regardless.
   */
  async findIssue(
    tenantId: string,
    externalKey: string,
    since: Date,
    directory: DeveloperDirectory,
  ): Promise<{ issue: IssueRecord; inWindow: boolean } | null> {
    const s = await this.prisma.story.findFirst({
      where: { tenantId, externalKey },
      select: STORY_SELECT,
    });
    return s
      ? { issue: toIssue(s, directory), inWindow: isIssueInWindow(s, since) }
      : null;
  }
}

/**
 * Which PRs belong in memory: still open, or opened or merged inside the
 * window. Activity dates rather than `updatedAt`, which moves on every
 * re-collection and would drag ancient PRs back in.
 */
function prWindow(since: Date) {
  return {
    OR: [
      { state: 'open' },
      { openedAt: { gte: since } },
      { mergedAt: { gte: since } },
    ],
  };
}

/**
 * Which assigned issues belong in memory on their own: not done, or created
 * or resolved inside the window. Again source dates, not `updatedAt` — the
 * Jira poller re-upserts every issue it walks, which made "updated in the
 * window" true of nearly the whole backlog. A null `statusCategory` (an issue
 * collected before the field existed) counts as not done, the convention
 * `DeveloperActivityService.openAssignedByDeveloper` uses.
 *
 * `isIssueInWindow` is the same rule for one row; the two must agree.
 */
function issueWindow(since: Date) {
  return {
    OR: [
      { statusCategory: null },
      { statusCategory: { not: 'done' } },
      { resolvedAt: { gte: since } },
      { sourceCreatedAt: { gte: since } },
    ],
  };
}

export function isIssueInWindow(
  s: Pick<StoryRow, 'statusCategory' | 'resolvedAt' | 'sourceCreatedAt'>,
  since: Date,
): boolean {
  return (
    s.statusCategory !== 'done' ||
    (s.resolvedAt !== null && s.resolvedAt >= since) ||
    (s.sourceCreatedAt !== null && s.sourceCreatedAt >= since)
  );
}

/** The PR reference correlation links use (`correlation.service.ts`). */
export function prRefOf(repoFullName: string, externalNumber: string): string {
  return `${repoFullName}#${externalNumber}`;
}

function toPullRequest(
  pr: PrRow,
  reviews: ReviewRow[],
  links: LinkRow[],
  issues: Map<string, IssueRecord>,
  directory: DeveloperDirectory,
): PullRequestRecord {
  return {
    id: pr.id,
    repoFullName: pr.repoFullName,
    number: pr.externalNumber,
    title: pr.title,
    state: pr.state,
    openedAt: pr.openedAt,
    mergedAt: pr.mergedAt,
    author: directory.loginAuthor(pr.authorLogin),
    reviews: reviews.map((r): ReviewRecord => ({
      id: r.id,
      repoFullName: r.repoFullName,
      prNumber: r.externalNumber,
      state: r.state,
      submittedAt: r.submittedAt,
      isBot: r.isBot,
      reviewer: directory.loginAuthor(r.reviewerLogin),
    })),
    // A link to a story we no longer hold is dropped, not invented.
    issueLinks: links.flatMap((l): IssueLinkRecord[] => {
      const issue = issues.get(l.toId);
      return issue
        ? [{ issue, confidence: l.confidence, method: l.method }]
        : [];
    }),
  };
}

function toIssue(s: StoryRow, directory: DeveloperDirectory): IssueRecord {
  return {
    id: s.id,
    key: s.externalKey,
    title: s.title,
    status: s.status,
    type: s.type,
    assignee: directory.assignee(s),
  };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = out.get(k);
    if (group) {
      group.push(item);
    } else {
      out.set(k, [item]);
    }
  }
  return out;
}
