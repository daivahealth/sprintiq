import { Injectable } from '@nestjs/common';
import { PrReview, PullRequest, Sprint } from '@prisma/client';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { istDateKey } from '../common/time';
import { DeveloperIdentityService } from '../correlation/developer-identity.service';
import {
  isAnonymizedAccount,
  isBotDeveloper,
} from '../correlation/developer-identity.util';
import { PrismaService } from '../database/prisma.service';
import { CodeService } from '../modules/code/code.service';
import { PlanningService } from '../modules/planning/planning.service';
import { attributeCommit } from './developer-activity.service';
import { InsightsService } from './insights.service';

/** The sprint's own elapsed window, clamped to now. */
export interface SprintWindowDates {
  from: Date;
  to: Date;
  /** IST calendar-day keys covered, inclusive of both ends. */
  dayKeys: string[];
}

/**
 * `SprintWindowDates` plus the repos the sprint's project maps to.
 *
 * `repos` costs its own read (`insights.repoToProjects`, an N+1 scan over
 * every project) on top of the dates, so it is a separate, wider type rather
 * than a field every caller pays for — see `window()`/`sprintWindow()` below.
 */
export interface SprintWindow extends SprintWindowDates {
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

export interface RcStory {
  key: string;
  title: string;
  delivered: boolean;
}

export interface ReleaseCandidateView {
  name: string;
  externalId: string | null;
  plannedReleaseAt: string | null;
  actualReleaseAt: string | null;
  released: boolean;
  daysLate: number | null;
  storiesDelivered: number;
  storiesTotal: number;
  stories: RcStory[];
  bugsByPriority: { priority: string; count: number }[];
  bugSource: 'affects-version' | 'fix-version-fallback';
  /**
   * Always `null`. Test execution lives in a separate test-management app
   * this platform does not integrate with — the field exists so the client
   * can render "not collected" rather than guess a shape for data that was
   * never fetched.
   */
  testExecution: null;
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
/**
 * Jira's five priority levels, **always rendered — including at zero**.
 *
 * Emitting only the levels a sprint happened to use made the chart change
 * shape as the reader moved between sprints: on the reference tenant
 * Sprint-26-2 showed Highest/High/Medium and Sprint-26-1 showed High/Medium,
 * so the top bar silently became a different severity. It also erased the
 * difference between "no Lowest bugs this sprint" and "this board does not
 * track Lowest" — across every ACT sprint, Low and Lowest never appeared once,
 * though the tenant holds hundreds of both.
 *
 * A zero here is a fact the query establishes, not an absence being guessed
 * at, which is why it is shown as `0` rather than the em-dash this platform
 * reserves for unknowns.
 */
const JIRA_PRIORITY_LEVELS = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];

/**
 * Our label for a bug with no priority set — not one of Jira's levels, so it
 * appears only when something is actually in it. A permanent zero row would
 * imply the instance has a category it does not.
 */
const UNPRIORITISED = 'Unprioritised';

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

export interface CheckInRow {
  /**
   * Canonical developer id where the Jira author bridges to one (the same
   * identity `productivity` reports under) — falls back to the raw Jira
   * author login when no bridge is recorded.
   */
  developer: string;
  displayName: string;
  /** One entry per day in `CheckInsView.days`, same order. */
  counts: number[];
  total: number;
}

export interface CheckInsView {
  /** IST date keys, ascending. */
  days: string[];
  /** Sorted by `total` descending — an activity picture, not a register. */
  rows: CheckInRow[];
  /**
   * IST date keys (same form as `days`) — the ELAPSED window
   * (`sprintWindow().win.from`/`win.to`), not the sprint's full planned bounds:
   * the days this sprint has actually had, not the days it was allotted.
   * Identical to the sprint's own start/end once it closes; only a running
   * sprint differs. The pager (Task 12) builds its pages from exactly these
   * two fields, so a page can never be offered for days that have not
   * happened yet. Deliberately not an ISO instant: `days`, `sprintFrom` and
   * `sprintTo` all speak the same IST-date-key unit so a page boundary can
   * never land a calendar day off the grid's own column headers.
   */
  sprintFrom: string | null;
  sprintTo: string | null;
}

/** Days shown per page when the caller does not specify a range. */
const CHECK_IN_PAGE_DAYS = 7;

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
    projects: string[] = [],
  ): Promise<CommitActivityView | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const found = await this.window(tenantId, sprintExternalId, projects);
    if (!found) {
      return null;
    }
    const { win } = found;

    // No repo mapped to this sprint's project contributes nothing — passing
    // an empty `repos` filter through to `listCommitsPage` would instead read
    // as "no filter" and return every repo in the tenant.
    const [items, commitsPage, index, prs] = await Promise.all([
      this.planning.listItemsForSprint(tenantId, sprintExternalId, projects),
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

    // Bots and deprovisioned accounts stay OUT of this head-count — it is
    // read against a Jira-assignee denominator ("N of M assigned") that can
    // never contain a bot — but their commits still count in `commits.length`
    // below. Matches `bridgeCoverage`'s rule exactly: excluded from figures
    // that count people, not from the work.
    const committers = new Set<string>();
    for (const commit of commits) {
      const person = attributeCommit(commit, index);
      if (person && !isBotDeveloper(person) && !isAnonymizedAccount(person)) {
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
    projects: string[] = [],
  ): Promise<ProductivityView | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const found = await this.window(tenantId, sprintExternalId, projects);
    if (!found) {
      return null;
    }
    const { win } = found;

    // Same discipline as `commitActivity`: an unmapped project reads no repo
    // rather than reading every repo `listCommitsPage` treats `repos: []` as.
    const [items, commitsPage, index, jiraIndex, prs, reviews] =
      await Promise.all([
        this.planning.listItemsForSprint(tenantId, sprintExternalId, projects),
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
    // from.
    //
    // NOT the same population the check-in grid counts over, despite both
    // reading `issue_status_history` over these same item keys: this counts
    // DISTINCT ticket KEYS per sprint (`ticketsWorked`), the grid counts
    // transition EVENTS per day. A person who moves one ticket through six
    // statuses shows `1` here and `6` there — both are correct, they answer
    // different questions, and the two panels are not expected to agree.
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

    // Bots and deprovisioned accounts never become a ROW on this table: it is
    // the one board on the platform that publishes an attributed per-person
    // grade, and a bot (Dependabot raises plenty of PRs) can otherwise land
    // in the top tertile and be graded `high` right next to the humans it's
    // compared against. Matches `bridgeCoverage`'s rule — excluded from
    // figures that count PEOPLE. Their commits still land in `commits`/LOC
    // totals elsewhere (`commitActivity`'s `commits.length`, unaffected).
    const isExcludedPerson = (person: string) =>
      isBotDeveloper(person) || isAnonymizedAccount(person);

    for (const commit of commitsPage.commits) {
      const person = attributeCommit(commit, index);
      if (!person || isExcludedPerson(person)) {
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
      if (!person || isExcludedPerson(person)) {
        continue;
      }
      acc(person).ticketKeys.add(t.externalKey);
    }

    for (const pr of prs) {
      if (!pr.authorLogin) {
        continue;
      }
      const person = index.byLogin.get(pr.authorLogin) ?? pr.authorLogin;
      if (isExcludedPerson(person)) {
        continue;
      }
      acc(person).prsRaised += 1;
    }

    for (const review of reviews) {
      if (review.isBot || !review.reviewerLogin) {
        continue;
      }
      const person =
        index.byLogin.get(review.reviewerLogin) ?? review.reviewerLogin;
      if (isExcludedPerson(person)) {
        continue;
      }
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
    projects: string[] = [],
  ): Promise<QualityCheckView | null> {
    const tenantId = this.tenantContext.requireTenantId();
    // The dates-only window: this panel never dereferences `win.repos`, so it
    // skips `window()`'s repo lookup (`insights.repoToProjects`) entirely.
    const found = await this.sprintWindow(tenantId, sprintExternalId);
    if (!found) {
      return null;
    }
    const { win } = found;

    const items = await this.planning.listItemsForSprint(
      tenantId,
      sprintExternalId,
      projects,
    );

    // Same discipline as `productivity`'s ticketsWorked: scoped to THIS
    // SPRINT'S OWN item keys, and skipped entirely when there are none. Not
    // because Prisma reads an empty `in` as "no filter" — it doesn't; `{ in:
    // [] }` matches nothing, so the query would already return `[]` — this
    // guard only saves the round trip when there is nothing to release or
    // roll back without items.
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
      // Denominator is every item that ENTERED done in the window — released
      // or not — not `storiesReleased`. `storiesReleased` additionally
      // requires a release AND a CURRENT status of done, and a rollback by
      // definition flips status away from done, so the old denominator
      // excluded exactly the items the numerator counts: `pct` could exceed
      // 100%, and the panel rendered a negative-width bar next to an
      // over-wide one. `reachedDoneInWindow` has no such requirement, so
      // every rollback (which can only happen to an item that was in `done`)
      // is counted against a population it is a genuine subset of.
      rolledBackPct: pct(rolledBackKeys.size, reachedDoneInWindow.size),
      bugsByPriority: bugsByPriority(bugs),
      bugsLogged,
      bugsPerStoryReleased:
        storiesReleased > 0 ? round1(bugsLogged / storiesReleased) : null,
    };
  }

  /**
   * Ticket movement per developer per IST day.
   *
   * NOT the same population `productivity` cuts its grade from, despite both
   * reading `issue_status_history` over the sprint's own item keys: this
   * counts transition EVENTS per day, `productivity`'s `ticketsWorked` counts
   * distinct ticket KEYS per sprint. A person who moves one ticket through
   * six statuses shows `6` here and `1` there — both are correct, and the two
   * panels are not expected to agree. What DOES have to agree is who the
   * person IS: identities are resolved through the same Jira-login/name →
   * canonical-developer bridge `productivity` uses (falling back to the raw
   * Jira login when no bridge exists), so the same person can't show up under
   * two different names across the two panels.
   */
  async checkIns(
    sprintExternalId: string,
    projects: string[] = [],
    from?: Date,
    to?: Date,
  ): Promise<CheckInsView | null> {
    const tenantId = this.tenantContext.requireTenantId();
    // The dates-only window: this panel never dereferences `win.repos`, so it
    // skips `window()`'s repo lookup (`insights.repoToProjects`) entirely.
    const found = await this.sprintWindow(tenantId, sprintExternalId);
    if (!found) {
      return null;
    }
    const { win } = found;

    // The range the caller asked for, clamped into the sprint's own elapsed
    // window on BOTH ends before `end` is derived from `start` — a grid
    // showing days the sprint did not run reports zeros that mean "not a
    // sprint day", indistinguishable from "nobody moved anything", and a
    // request that lands entirely outside the window (a stale link, a
    // hand-edited URL, or the pager's own math) must degrade to the nearest
    // valid days rather than invert into an empty grid. `start` is clamped
    // first; `end` is then floored at `start` so it can never fall below it.
    const start = minDate(maxDate(from ?? win.from, win.from), win.to);
    const end = maxDate(
      minDate(to ?? addDays(start, CHECK_IN_PAGE_DAYS - 1), win.to),
      start,
    );
    const days = dayKeysBetween(start, end);
    const dayIndex = new Map(days.map((key, i) => [key, i]));

    const [items, index, jiraIndex] = await Promise.all([
      this.planning.listItemsForSprint(tenantId, sprintExternalId, projects),
      this.identities.attributionIndex(tenantId),
      this.identities.jiraAssigneeIndex(tenantId),
    ]);

    // Same discipline as `productivity`/`qualityCheck`: scoped to THIS
    // SPRINT'S OWN item keys, and skipped entirely when there are none. Not
    // because Prisma reads an empty `in` as "no filter" — it doesn't; `{ in:
    // [] }` matches nothing, so the query would already return `[]` — this
    // guard only saves the round trip.
    const sprintKeys = items.map((item) => item.externalKey);
    const transitions =
      sprintKeys.length > 0
        ? await this.prisma.issueStatusHistory.findMany({
            where: {
              tenantId,
              externalKey: { in: sprintKeys },
              transitionedAt: { gte: start, lte: end },
            },
            select: {
              authorLogin: true,
              authorName: true,
              transitionedAt: true,
            },
          })
        : [];

    // The same Jira-side bridge `productivity` builds, so the same person
    // keys identically on both panels.
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

    interface Acc {
      displayName: string;
      counts: number[];
    }
    const byDeveloper = new Map<string, Acc>();
    for (const t of transitions) {
      if (!t.authorLogin) {
        continue;
      }
      const dayKey = istDateKey(t.transitionedAt);
      const idx = dayIndex.get(dayKey);
      if (idx === undefined) {
        continue;
      }
      // Resolved to the canonical developer id where the Jira login/name
      // bridges to one — same lookup `productivity` uses — and falls back to
      // the raw Jira login otherwise, so a transition from someone with no
      // recorded bridge still shows on the grid rather than disappearing.
      const person =
        developerByJiraLogin.get(t.authorLogin) ??
        (t.authorName ? developerByJiraName.get(t.authorName) : undefined) ??
        t.authorLogin;
      let acc = byDeveloper.get(person);
      if (!acc) {
        acc = {
          displayName: index.displayNames.get(person) ?? t.authorName ?? person,
          counts: days.map(() => 0),
        };
        byDeveloper.set(person, acc);
      }
      acc.counts[idx] += 1;
    }

    const rows: CheckInRow[] = [...byDeveloper.entries()]
      .map(([developer, acc]) => ({
        developer,
        displayName: acc.displayName,
        counts: acc.counts,
        total: acc.counts.reduce((a, b) => a + b, 0),
      }))
      // Volume order, not alphabetical — the grid reads as an activity
      // picture. `displayName` only breaks an exact tie so ordering stays
      // deterministic.
      .sort(
        (a, b) =>
          b.total - a.total || a.displayName.localeCompare(b.displayName),
      );

    return {
      days,
      rows,
      // The elapsed window, not the sprint's full planned bounds — see
      // `CheckInsView.sprintFrom` for why. IST date keys, same unit as
      // `days`, not ISO instants.
      sprintFrom: istDateKey(win.from),
      sprintTo: istDateKey(win.to),
    };
  }

  /**
   * One entry per release the sprint's own items carry, joined against the
   * `planning_release` row Jira and the plan-date mutation (Task 11) feed.
   *
   * `bugSource` is decided once for the whole sprint, not per release: whether
   * `affectsReleases` is populated depends on when an item was collected (the
   * field's rollout), not on which release it belongs to, so a single flag
   * keeps every card in this panel answering the same question.
   */
  async releaseCandidates(
    sprintExternalId: string,
    projects: string[] = [],
  ): Promise<ReleaseCandidateView[] | null> {
    const tenantId = this.tenantContext.requireTenantId();
    // Neither `win.repos` nor even `win.from`/`win.to` is read below — only
    // `sprint.projectKey` — so this reaches the sprint directly rather than
    // through `window()`/`sprintWindow()`. That also lifts `window()`'s
    // `!sprint?.startAt` gate, which this panel does not need: a sprint with
    // no recorded start date has no dates to compute, but its items still
    // carry releases worth reporting on.
    const sprint = await this.planning.findSprintByExternalId(
      tenantId,
      sprintExternalId,
    );
    if (!sprint) {
      return null;
    }

    // Deliberately `prisma.story.findMany`, not `planning.listItemsForSprint`
    // (which runs this exact query): `PlanningService.listReleases` — the
    // only release-side read it exposes — has no per-name filter, caps at
    // 100 rows, and orders differently, so it cannot serve the query below.
    // Reaching `prisma.release` directly here means the paired story read
    // has to bypass the service layer too, or the two queries would answer
    // from two different abstractions for one panel.
    const items = await this.prisma.story.findMany({
      where: {
        tenantId,
        sprintExternalId,
        // Narrowed to the projects in scope for the same reason every other
        // panel is: this sprint can hold work from 25 projects, and an RC
        // list mixing all of them answers nobody's question.
        ...(projects.length > 0 ? { projectKey: { in: projects } } : {}),
      },
    });

    // Same discipline as every other read in this file: skipped entirely
    // when there are none. Not because Prisma reads an empty `in` as "no
    // filter" — it doesn't; `{ in: [] }` matches nothing — this guard only
    // saves the round trip when there is nothing to report on.
    const releaseNames = [...new Set(items.flatMap((item) => item.releases))];
    if (releaseNames.length === 0) {
      return [];
    }

    const releases = await this.prisma.release.findMany({
      where: {
        tenantId,
        projectKey: sprint.projectKey,
        name: { in: releaseNames },
      },
    });

    const bugs = items.filter((item) => item.type === 'bug');
    const bugSource: ReleaseCandidateView['bugSource'] = bugs.some(
      (bug) => bug.affectsReleases.length > 0,
    )
      ? 'affects-version'
      : 'fix-version-fallback';

    return [...releases]
      .sort((a, b) => {
        const ta = a.releaseDate?.getTime() ?? Number.POSITIVE_INFINITY;
        const tb = b.releaseDate?.getTime() ?? Number.POSITIVE_INFINITY;
        return ta - tb || a.name.localeCompare(b.name);
      })
      .map((release) => {
        // A card's scope list is the deliverables a reader would recognise:
        // bugs are counted separately below, an epic is a container rather
        // than something shipped, and a subtask carries its parent's release
        // without adding any work the parent doesn't already report — so all
        // three are excluded here, the same way `buildSprintHealth` already
        // filters epics out of its item counts.
        const stories: RcStory[] = items
          .filter(
            (item) =>
              !['bug', 'epic', 'subtask'].includes(item.type) &&
              item.releases.includes(release.name),
          )
          .map((item) => ({
            key: item.externalKey,
            title: item.title,
            delivered: item.statusCategory === 'done',
          }));

        const rcBugs = bugs.filter((bug) =>
          bugSource === 'affects-version'
            ? bug.affectsReleases.includes(release.name)
            : bug.releases.includes(release.name),
        );

        // Jira's `releaseDate` means "expected to finish" while unreleased and
        // "shipped on" once `released` flips — reporting it as an actual date
        // beforehand would claim something that has not happened.
        const actualReleaseAt = release.released ? release.releaseDate : null;
        const daysLate =
          release.plannedReleaseAt && actualReleaseAt
            ? Math.round(
                (actualReleaseAt.getTime() -
                  release.plannedReleaseAt.getTime()) /
                  86_400_000,
              )
            : null;

        return {
          name: release.name,
          externalId: release.externalId ?? null,
          plannedReleaseAt: release.plannedReleaseAt?.toISOString() ?? null,
          actualReleaseAt: actualReleaseAt?.toISOString() ?? null,
          released: release.released,
          daysLate,
          storiesDelivered: stories.filter((s) => s.delivered).length,
          storiesTotal: stories.length,
          stories,
          bugsByPriority: bugsByPriority(rcBugs),
          bugSource,
          testExecution: null,
        };
      });
  }

  /**
   * The sprint's own elapsed window, clamped to now — WITHOUT the repos it
   * maps to. Split from `window()` below because resolving `repos` costs its
   * own read (`insights.repoToProjects`, an N+1 scan over every project),
   * and three of the five panels on this board (`qualityCheck`, `checkIns`,
   * and — via a still-lighter path — `releaseCandidates`) never dereference
   * `win.repos`. `GET /sprint-health` calls `window()` three times
   * concurrently plus one more each for check-ins/release-candidates; making
   * repos opt-in cuts that N+1 down to the two panels that actually need it.
   */
  private async sprintWindow(
    tenantId: string,
    sprintExternalId: string,
  ): Promise<{ sprint: Sprint; win: SprintWindowDates } | null> {
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
    return { sprint, win: { from, to, dayKeys: dayKeysBetween(from, to) } };
  }

  /**
   * `sprintWindow()` plus the repos the sprint's project maps to — for the
   * two panels (`commitActivity`, `productivity`) that actually read
   * `win.repos`. A running sprint is measured over the days it has actually
   * had, not the days it was allotted: averaging 14 days of commits over a
   * 21-day plan understates a team mid-sprint.
   */
  private async window(
    tenantId: string,
    sprintExternalId: string,
    projects: string[] = [],
  ): Promise<{ sprint: Sprint; win: SprintWindow } | null> {
    const found = await this.sprintWindow(tenantId, sprintExternalId);
    if (!found) {
      return null;
    }
    const { sprint, win } = found;
    // The projects the reader selected, or — when they selected none — the one
    // the sprint row names. Falling back to `sprint.projectKey` alone was the
    // bug: it is a single value assigned by first observation, so a sprint
    // ACT merely participates in reports CMS's repos and none of ACT's.
    const scope = projects.length > 0 ? projects : [sprint.projectKey];
    const repoToProjects = await this.insights.repoToProjects(tenantId);
    const repos = [...repoToProjects.entries()]
      .filter(([, mapped]) => mapped.some((p) => scope.includes(p)))
      .map(([repo]) => repo);
    return { sprint, win: { ...win, repos } };
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

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

function minDate(a: Date, b: Date): Date {
  return a < b ? a : b;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
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
    const priority = bug.priority ?? UNPRIORITISED;
    if (!counts.has(priority)) {
      counts.set(priority, 0);
      encounterOrder.push(priority);
    }
    counts.set(priority, counts.get(priority)! + 1);
  }

  // The five levels always, so the axis is the same on every sprint; then
  // Unprioritised if anything landed there; then any name this Jira instance
  // has that the canonical list does not, in the order it was met.
  const rows = [...JIRA_PRIORITY_LEVELS];
  if (counts.has(UNPRIORITISED)) {
    rows.push(UNPRIORITISED);
  }
  for (const priority of encounterOrder) {
    if (!rows.includes(priority)) {
      rows.push(priority);
    }
  }
  return rows.map((priority) => ({
    priority,
    count: counts.get(priority) ?? 0,
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
