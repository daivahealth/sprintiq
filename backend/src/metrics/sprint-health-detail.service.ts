import { Injectable } from '@nestjs/common';
import { PrReview, PullRequest, Sprint } from '@prisma/client';
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

export type ProductivityGrade = 'high' | 'medium' | 'low';

export interface ProductivityRow {
  /** Canonical developer id. */
  developer: string;
  displayName: string;
  additions: number;
  deletions: number;
  ticketsWorked: number;
  commits: number;
  prsRaised: number;
  prsReviewed: number;
  /** The composite the grade is cut from. */
  score: number;
  grade: ProductivityGrade;
}

export interface ProductivityView {
  /** Sorted by `score` descending — the same order the grade cut reads. */
  rows: ProductivityRow[];
  highest: { additions: number } | null;
  lowest: { additions: number } | null;
  gradeRule: string;
}

export interface QualityCheckView {
  storiesReleased: number;
  rolledBack: number;
  rolledBackPct: number | null;
  bugsByPriority: { priority: string; count: number }[];
  bugsLogged: number;
  bugsPerStoryReleased: number | null;
}

/** Canonical bug-priority ordering; any unknown name is appended after these. */
const BUG_PRIORITY_ORDER = [
  'Highest',
  'High',
  'Medium',
  'Low',
  'Lowest',
  'Unprioritised',
];

/**
 * The composite the high/medium/low grade is cut from.
 *
 * Deliberately excludes lines of code. LOC measures how much text changed, not
 * how much was delivered, and a grade that tracked it would reward churn and
 * punish the person who deleted 400 lines of dead code. The rule ships to the
 * client in `gradeRule` and is printed under the table, so the reader can
 * check the verdict rather than trust it.
 */
const scoreOf = (r: {
  ticketsWorked: number;
  prsRaised: number;
  prsReviewed: number;
}) => r.ticketsWorked + r.prsRaised + r.prsReviewed;

const GRADE_RULE =
  "Tertiles of tickets worked + PRs raised + reviews submitted, across this sprint's contributors — not lines of code.";

/** Fewer than this many scored contributors is not a distribution to cut. */
const MIN_CONTRIBUTORS_TO_RANK = 3;

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
   * Per-developer productivity for the sprint, graded high/medium/low.
   *
   * The grade is cut from `scoreOf` — tickets worked + PRs raised + reviews
   * submitted — never from LOC. `additions`/`deletions` still ride along on
   * each row because the reader needs to SEE the LOC figure to trust that it
   * didn't drive the grade next to it.
   */
  async productivity(
    sprintExternalId: string,
  ): Promise<ProductivityView | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const found = await this.window(tenantId, sprintExternalId);
    if (!found) {
      return null;
    }
    const { win } = found;

    // Same discipline as `commitActivity`: an unmapped project reads no repo
    // rather than reading every repo `listCommitsPage` treats `repos: []` as.
    const [items, commitsPage, index, jiraIndex, prs, reviews] =
      await Promise.all([
        this.planning.listItemsForSprint(tenantId, sprintExternalId),
        win.repos.length > 0
          ? this.code.listCommitsPage(tenantId, {
              repos: win.repos,
              from: win.from,
              to: win.to,
            })
          : Promise.resolve({ commits: [], truncated: false }),
        this.identities.attributionIndex(tenantId),
        this.identities.jiraAssigneeIndex(tenantId),
        win.repos.length > 0
          ? this.prisma.pullRequest.findMany({
              where: {
                tenantId,
                repoFullName: { in: win.repos },
                openedAt: { gte: win.from, lte: win.to },
              },
            })
          : Promise.resolve<PullRequest[]>([]),
        win.repos.length > 0
          ? this.prisma.prReview.findMany({
              where: {
                tenantId,
                repoFullName: { in: win.repos },
                submittedAt: { gte: win.from, lte: win.to },
              },
            })
          : Promise.resolve<PrReview[]>([]),
      ]);

    // Scoped to THIS SPRINT'S OWN item keys, not merely the project: a
    // tenant-wide (or project-wide) window would fold in a developer's
    // transitions on any OTHER sprint's issue that happens to fall inside
    // these calendar dates, corrupting the exact composite the grade is cut
    // from. Same population Task 9's check-in grid counts over, so the two
    // panels can never disagree about the same person's ticket movement.
    const sprintKeys = items.map((item) => item.externalKey);
    const transitions =
      sprintKeys.length > 0
        ? await this.prisma.issueStatusHistory.findMany({
            where: {
              tenantId,
              externalKey: { in: sprintKeys },
              transitionedAt: { gte: win.from, lte: win.to },
            },
            select: {
              externalKey: true,
              authorLogin: true,
              authorName: true,
            },
          })
        : [];

    interface Acc {
      additions: number;
      deletions: number;
      commits: number;
      ticketKeys: Set<string>;
      prsRaised: number;
      prsReviewed: number;
    }
    const byDeveloper = new Map<string, Acc>();
    const acc = (developer: string): Acc => {
      let a = byDeveloper.get(developer);
      if (!a) {
        a = {
          additions: 0,
          deletions: 0,
          commits: 0,
          ticketKeys: new Set<string>(),
          prsRaised: 0,
          prsReviewed: 0,
        };
        byDeveloper.set(developer, a);
      }
      return a;
    };

    for (const commit of commitsPage.commits) {
      const person = attributeCommit(commit, index);
      if (!person) {
        continue;
      }
      const a = acc(person);
      a.additions += commit.additions;
      a.deletions += commit.deletions;
      a.commits += 1;
    }

    // The Jira-side reverse of `jiraAssigneeIndex` — same shape of lookup as
    // `openAssignedByDeveloper` in DeveloperActivityService: a login/name with
    // no matching identity row is invisible to us, so it is skipped rather
    // than counted against a guessed developer.
    const developerByJiraLogin = new Map<string, string>();
    const developerByJiraName = new Map<string, string>();
    for (const [developer, refs] of jiraIndex.byDeveloper) {
      for (const login of refs.logins) {
        developerByJiraLogin.set(login, developer);
      }
      for (const name of refs.names) {
        developerByJiraName.set(name, developer);
      }
    }
    for (const t of transitions) {
      const person =
        (t.authorLogin ? developerByJiraLogin.get(t.authorLogin) : undefined) ??
        (t.authorName ? developerByJiraName.get(t.authorName) : undefined);
      if (!person) {
        continue;
      }
      acc(person).ticketKeys.add(t.externalKey);
    }

    for (const pr of prs) {
      if (!pr.authorLogin) {
        continue;
      }
      const person = index.byLogin.get(pr.authorLogin) ?? pr.authorLogin;
      acc(person).prsRaised += 1;
    }

    for (const review of reviews) {
      if (review.isBot || !review.reviewerLogin) {
        continue;
      }
      const person =
        index.byLogin.get(review.reviewerLogin) ?? review.reviewerLogin;
      acc(person).prsReviewed += 1;
    }

    const scored = [...byDeveloper.entries()]
      .map(([developer, a]) => {
        const row = {
          developer,
          displayName: index.displayNames.get(developer) ?? developer,
          additions: a.additions,
          deletions: a.deletions,
          ticketsWorked: a.ticketKeys.size,
          commits: a.commits,
          prsRaised: a.prsRaised,
          prsReviewed: a.prsReviewed,
        };
        return { ...row, score: scoreOf(row) };
      })
      // Highest score first — the order the tertile cut reads, and the order
      // the table renders in. `displayName` breaks a tied score so two equal
      // rows can never land in different bands by incidental Map-insertion
      // order — the panel's whole claim is that the verdict is checkable.
      .sort(
        (a, b) =>
          b.score - a.score || a.displayName.localeCompare(b.displayName),
      );

    // Only contributors who carry SOME signal are a distribution to cut. A
    // commit-only developer (score 0 — real work, but not this composite's
    // kind) is not a rankable contributor: including them would let two
    // zero-score developers pad `scored.length` past the threshold and hand
    // the one actual signal-carrier a "high" grade off an n of one.
    const signalCarriers = scored.filter((r) => r.score > 0);
    const tooFewToRank = signalCarriers.length < MIN_CONTRIBUTORS_TO_RANK;

    let rows: ProductivityRow[];
    if (tooFewToRank) {
      rows = scored.map((r) => ({ ...r, grade: 'medium' as const }));
    } else {
      // Zero-score developers stay in the table — they did real work, and
      // dropping them would hide it — but they are graded `medium` (the
      // non-verdict) and excluded from the cut so they cannot shift its
      // boundaries. Grading them `low` would assert underperformance from a
      // composite that ignores their commits entirely: the exact LOC
      // blindness this panel exists to avoid, inverted.
      const gradeByDeveloper = new Map(
        gradeByTertile(signalCarriers).map((r) => [r.developer, r.grade]),
      );
      rows = scored.map((r) => ({
        ...r,
        grade: gradeByDeveloper.get(r.developer) ?? 'medium',
      }));
    }

    return {
      rows,
      highest: tooFewToRank
        ? null
        : { additions: Math.max(...scored.map((r) => r.additions)) },
      lowest: tooFewToRank
        ? null
        : { additions: Math.min(...scored.map((r) => r.additions)) },
      gradeRule: GRADE_RULE,
    };
  }

  /**
   * Releases, rollbacks and bug load — the release-quality signals that share
   * this sprint's own status history.
   *
   * `rolledBack` is read from `IssueStatusHistory`, not the story row: a story
   * that was reopened and then re-fixed shows an ordinary "done" as its
   * current status, and only the transition timeline shows it ever left.
   */
  async qualityCheck(
    sprintExternalId: string,
  ): Promise<QualityCheckView | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const found = await this.window(tenantId, sprintExternalId);
    if (!found) {
      return null;
    }
    const { win } = found;

    const items = await this.planning.listItemsForSprint(
      tenantId,
      sprintExternalId,
    );

    // Same discipline as `productivity`'s ticketsWorked: scoped to THIS
    // SPRINT'S OWN item keys, and skipped entirely when there are none — an
    // unscoped `in` filter reads as "match everything" once it's empty, and
    // there is nothing to release or roll back without items.
    const sprintKeys = items.map((item) => item.externalKey);
    const transitions =
      sprintKeys.length > 0
        ? await this.prisma.issueStatusHistory.findMany({
            where: {
              tenantId,
              externalKey: { in: sprintKeys },
              transitionedAt: { gte: win.from, lte: win.to },
            },
            select: {
              externalKey: true,
              fromCategory: true,
              toCategory: true,
            },
          })
        : [];

    const reachedDoneInWindow = new Set(
      transitions
        .filter((t) => t.toCategory === 'done')
        .map((t) => t.externalKey),
    );
    const rolledBackKeys = new Set(
      transitions
        .filter((t) => t.fromCategory === 'done' && t.toCategory !== 'done')
        .map((t) => t.externalKey),
    );

    const storiesReleased = items.filter(
      (item) =>
        item.releases.length > 0 &&
        item.statusCategory === 'done' &&
        reachedDoneInWindow.has(item.externalKey),
    ).length;

    const bugs = items.filter((item) => item.type === 'bug');
    const bugsLogged = bugs.length;

    return {
      storiesReleased,
      rolledBack: rolledBackKeys.size,
      rolledBackPct: pct(rolledBackKeys.size, storiesReleased),
      bugsByPriority: bugsByPriority(bugs),
      bugsLogged,
      bugsPerStoryReleased:
        storiesReleased > 0 ? round1(bugsLogged / storiesReleased) : null,
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

/**
 * Groups bug items by `priority` (null → `'Unprioritised'`), ordered
 * `Highest, High, Medium, Low, Lowest, Unprioritised` — any priority name
 * outside that set is appended in the order it was first encountered.
 */
function bugsByPriority(
  bugs: { priority: string | null }[],
): { priority: string; count: number }[] {
  const counts = new Map<string, number>();
  const encounterOrder: string[] = [];
  for (const bug of bugs) {
    const priority = bug.priority ?? 'Unprioritised';
    if (!counts.has(priority)) {
      counts.set(priority, 0);
      encounterOrder.push(priority);
    }
    counts.set(priority, counts.get(priority)! + 1);
  }
  const known = BUG_PRIORITY_ORDER.filter((p) => counts.has(p));
  const unknown = encounterOrder.filter((p) => !BUG_PRIORITY_ORDER.includes(p));
  return [...known, ...unknown].map((priority) => ({
    priority,
    count: counts.get(priority)!,
  }));
}

/**
 * Cuts a score-descending list into three near-equal bands: the top third
 * graded `high`, the bottom third `low`, and the rest `medium`.
 *
 * Callers must have already filtered out the too-few-to-rank case — this
 * assumes at least `MIN_CONTRIBUTORS_TO_RANK` rows.
 */
function gradeByTertile<T extends { score: number }>(
  sortedByScoreDesc: T[],
): (T & { grade: ProductivityGrade })[] {
  const n = sortedByScoreDesc.length;
  const highBoundary = Math.floor(n / 3);
  const lowBoundary = Math.floor((2 * n) / 3);
  return sortedByScoreDesc.map((row, i) => ({
    ...row,
    grade: i < highBoundary ? 'high' : i < lowBoundary ? 'medium' : 'low',
  }));
}
