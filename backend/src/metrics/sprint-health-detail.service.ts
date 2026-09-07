import { Injectable } from '@nestjs/common';
import { PullRequest, Sprint } from '@prisma/client';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { istDateKey } from '../common/time';
import { DeveloperIdentityService } from '../correlation/developer-identity.service';
import { PrismaService } from '../database/prisma.service';
import { CodeService } from '../modules/code/code.service';
import { PlanningService } from '../modules/planning/planning.service';
import { attributeCommit } from './developer-activity.service';
import { InsightsService } from './insights.service';

/** The sprint's own window, clamped to now, plus the repos it maps to. */
export interface SprintWindow {
  from: Date;
  to: Date;
  /** IST calendar-day keys covered, inclusive of both ends. */
  dayKeys: string[];
  repos: string[];
}

export interface CommitActivityView {
  committers: number;
  assignees: number;
  commits: number;
  commitsPerDay: number | null;
  prsRaised: number;
  prsOpen: number;
  prsMerged: number;
  prsReviewed: number;
  reviewedPct: number | null;
  avgHoursToFirstReview: number | null;
  prsWaitingOver24h: number;
  repos: string[];
}

/** A PR waiting this long with no first review is flagged as waiting. */
const REVIEW_WAIT_THRESHOLD_HOURS = 24;

/**
 * BC-8 read model for the Sprint Health detail (DASHBOARDS.md §Sprint Health).
 *
 * Separate from InsightsService, which is already ~1,450 lines and owns the
 * pace ranking. This class owns one question — "what happened inside this
 * sprint" — and is sized to be held in one head.
 */
@Injectable()
export class SprintHealthDetailService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly planning: PlanningService,
    private readonly code: CodeService,
    private readonly identities: DeveloperIdentityService,
    private readonly insights: InsightsService,
  ) {}

  /**
   * Five commit-activity tiles: who committed, PR flow, and review latency —
   * all scoped to the sprint's own repos and its own window.
   */
  async commitActivity(
    sprintExternalId: string,
  ): Promise<CommitActivityView | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const found = await this.window(tenantId, sprintExternalId);
    if (!found) {
      return null;
    }
    const { win } = found;

    // No repo mapped to this sprint's project contributes nothing — passing
    // an empty `repos` filter through to `listCommitsPage` would instead read
    // as "no filter" and return every repo in the tenant.
    const [items, commitsPage, index, prs] = await Promise.all([
      this.planning.listItemsForSprint(tenantId, sprintExternalId),
      win.repos.length > 0
        ? this.code.listCommitsPage(tenantId, {
            repos: win.repos,
            from: win.from,
            to: win.to,
          })
        : Promise.resolve({ commits: [], truncated: false }),
      this.identities.attributionIndex(tenantId),
      win.repos.length > 0
        ? this.prisma.pullRequest.findMany({
            where: {
              tenantId,
              repoFullName: { in: win.repos },
              openedAt: { gte: win.from, lte: win.to },
            },
          })
        : Promise.resolve<PullRequest[]>([]),
    ]);
    const commits = commitsPage.commits;

    const committers = new Set<string>();
    for (const commit of commits) {
      const person = attributeCommit(commit, index);
      if (person) {
        committers.add(person);
      }
    }

    const assignees = new Set<string>();
    for (const item of items) {
      const who = item.assigneeLogin ?? item.assigneeName;
      if (who) {
        assignees.add(who);
      }
    }

    const reviewed = prs.filter((pr) => pr.firstReviewAt !== null);
    const reviewHours = reviewed
      .filter((pr) => pr.openedAt)
      .map(
        (pr) =>
          (pr.firstReviewAt!.getTime() - pr.openedAt!.getTime()) / 3_600_000,
      );

    const waitThresholdMs = REVIEW_WAIT_THRESHOLD_HOURS * 3_600_000;
    const now = Date.now();
    const prsWaitingOver24h = prs.filter(
      (pr) =>
        pr.firstReviewAt === null &&
        pr.openedAt !== null &&
        now - pr.openedAt.getTime() > waitThresholdMs,
    ).length;

    return {
      committers: committers.size,
      assignees: assignees.size,
      commits: commits.length,
      commitsPerDay:
        win.dayKeys.length > 0
          ? round1(commits.length / win.dayKeys.length)
          : null,
      prsRaised: prs.length,
      prsOpen: prs.filter((pr) => pr.state === 'open').length,
      prsMerged: prs.filter((pr) => pr.state === 'merged').length,
      prsReviewed: reviewed.length,
      reviewedPct: pct(reviewed.length, prs.length),
      avgHoursToFirstReview:
        reviewHours.length > 0 ? round1(mean(reviewHours)) : null,
      prsWaitingOver24h,
      repos: win.repos,
    };
  }

  /**
   * The sprint's own window, clamped to now: a running sprint is measured over
   * the days it has actually had, not the days it was allotted. Averaging 14
   * days of commits over a 21-day plan understates a team mid-sprint.
   */
  private async window(
    tenantId: string,
    sprintExternalId: string,
  ): Promise<{ sprint: Sprint; win: SprintWindow } | null> {
    const sprint = await this.planning.findSprintByExternalId(
      tenantId,
      sprintExternalId,
    );
    if (!sprint?.startAt) {
      return null;
    }
    const from = sprint.startAt;
    const to =
      sprint.endAt && sprint.endAt < new Date() ? sprint.endAt : new Date();
    const repoToProjects = await this.insights.repoToProjects(tenantId);
    const repos = [...repoToProjects.entries()]
      .filter(([, projects]) => projects.includes(sprint.projectKey))
      .map(([repo]) => repo);
    return {
      sprint,
      win: { from, to, dayKeys: dayKeysBetween(from, to), repos },
    };
  }
}

/** IST calendar-day keys covered by [from, to], inclusive of both ends. */
function dayKeysBetween(from: Date, to: Date): string[] {
  if (to < from) {
    return [];
  }
  const keys: string[] = [];
  let cursor = new Date(from);
  let key = istDateKey(cursor);
  const endKey = istDateKey(to);
  while (key <= endKey) {
    keys.push(key);
    cursor = new Date(cursor.getTime() + 86_400_000);
    key = istDateKey(cursor);
  }
  return keys;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round1(value: number): number {
  return Number(value.toFixed(1));
}

function pct(part: number, total: number): number | null {
  return total > 0 ? Number(((part / total) * 100).toFixed(1)) : null;
}
