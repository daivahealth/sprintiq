import { Injectable } from '@nestjs/common';
import { Commit, PrReview, PullRequest, Sprint, Story } from '@prisma/client';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { istDateKey } from '../common/time';
import { CorrelationService } from '../correlation/correlation.service';
import { DeveloperIdentityService } from '../correlation/developer-identity.service';
import {
  isAnonymizedAccount,
  isBotDeveloper,
} from '../correlation/developer-identity.util';
import { PrismaService } from '../database/prisma.service';
import { CodeService } from '../modules/code/code.service';
import {
  PlanningService,
  isJiraDone,
} from '../modules/planning/planning.service';
import { attributeCommit } from './developer-activity.service';
import { distinctCommitsBySha } from './commit-dedupe';
import { candidateTicketKeys, ticketKeysByCommit } from './developer-tickets';
import { isMergeCommit, partitionMerges } from './merge-commits';

/** The sprint's own elapsed window, clamped to now. */
export interface SprintWindowDates {
  from: Date;
  to: Date;
  /** IST calendar-day keys covered, inclusive of both ends. */
  dayKeys: string[];
}

/**
 * How the sprint's commits were found, and how much of the window they cover.
 *
 * Git has no sprint field, so a commit belongs to the sprint only when its
 * message or a branch it was on names one of the sprint's own tickets (in the
 * projects in scope). Every count here is over authored commits in the
 * sprint's window, each SHA once.
 */
export interface SprintCommitLinkage {
  /** The sprint's tickets in scope — what a commit has to name. */
  sprintTickets: number;
  /** Commits naming a sprint ticket — the population every tile counts. */
  linkedCommits: number;
  /** Of `linkedCommits`, the ones whose branch named the ticket but whose message did not. */
  linkedViaBranchOnly: number;
  /** Commits naming a ticket of the projects in scope that is not in this sprint. */
  otherTicketCommits: number;
  /**
   * Commits naming no ticket Jira knows — they cannot be placed in any
   * project, so this is the whole tenant's figure for the window, the same
   * whichever project is in scope.
   */
  noTicketCommits: number;
  /** Repositories the linked commits landed in. */
  reposTouched: string[];
  /** The window read hit its row ceiling, so every count here is a floor. */
  truncated: boolean;
}

/** The sprint's ticket-linked GitHub activity, shared by two panels. */
interface LinkedWork {
  /** Linked commits, merges included — callers split them. */
  commits: Commit[];
  /** PRs implementing a sprint ticket, opened inside the window. */
  prs: PullRequest[];
  /** Reviews on any PR implementing a sprint ticket, submitted inside the window. */
  reviews: PrReview[];
  /** Every PR implementing a sprint ticket, whenever it was opened. */
  allPrs: PullRequest[];
  /** PR refs (`repo#number`) per sprint story id. */
  refsByStory: Map<string, string[]>;
  /** Sprint ticket keys each linked commit names, by SHA. */
  ticketsBySha: Map<string, string[]>;
  /** Tickets of the projects in scope in NO sprint → authored commits naming them. */
  offSprintKeys: Map<string, number>;
  /** Tickets of the projects in scope in ANOTHER sprint → authored commits naming them. */
  otherSprintKeys: Map<string, number>;
  /** Keys shaped like a ticket of a project in scope that Jira does not know → commits. */
  unknownKeys: Map<string, number>;
  /** Authored commits naming no ticket-shaped key at all, by repository. */
  untaggedByRepo: Map<string, number>;
  linkage: SprintCommitLinkage;
}

/**
 * One way Jira's record lags, or misses, the GitHub work on the same tickets
 * — each with a known fix, which the board states beside it.
 *
 * Per ticket:
 * - `progress-not-marked`: code exists but Jira has not started the ticket
 *   (To Do, or a "ready for development" style status).
 * - `jira-not-updated`: a PR is merged, none is open, and Jira still holds the
 *   ticket in a development status.
 * - `in-qa`: a PR is merged and Jira is in a QA/UAT/review/defect status —
 *   the expected flow, reported for information only.
 * - `done-before-merge`: Jira says done while its only PRs are still open.
 * - `unassigned-with-code`: code exists, Jira has no assignee.
 * - `no-code-linked`: Jira has the ticket in development, but no commit,
 *   branch or PR names it.
 *
 * Sprint-wide (from commits, not tickets):
 * - `ticket-not-in-sprint`: commits name tickets of this project that are in
 *   no sprint (the backlog) — worked on, never planned.
 * - `ticket-in-other-sprint`: commits name tickets of this project that sit in
 *   another sprint — usually unfinished work not carried over.
 * - `ticket-not-logged`: commits name a key of this project Jira has no
 *   ticket for — never logged, or a typo.
 * - `commits-not-tagged`: commits in the repositories this sprint's work lives
 *   in name no ticket at all.
 *
 * QA vs development is read from the status NAME, because Jira's category
 * puts both in "in progress"; the patterns are `QA_STATUS` / `NOT_STARTED_STATUS`.
 */
export type DataGapKind =
  | 'progress-not-marked'
  | 'jira-not-updated'
  | 'in-qa'
  | 'done-before-merge'
  | 'unassigned-with-code'
  | 'no-code-linked'
  | 'ticket-not-in-sprint'
  | 'ticket-in-other-sprint'
  | 'ticket-not-logged'
  | 'commits-not-tagged';

export interface DataGapFinding {
  kind: DataGapKind;
  /** `action`: someone should fix the record. `info`: expected, shown for context. */
  severity: 'action' | 'info';
  /** Tickets affected (per-ticket kinds) or distinct keys / repos named (sprint-wide). */
  count: number;
  /** Authored commits behind a sprint-wide finding; null for per-ticket kinds. */
  commits: number | null;
  /** Up to `GAP_SAMPLE` keys (or repositories, for `commits-not-tagged`), most commits first. */
  sample: string[];
}

/** Jira's three board columns — the status CATEGORY, not the status name. */
export type JiraStatusBucket = 'todo' | 'in-progress' | 'done';

/**
 * How far a ticket's code has got, from GitHub alone: a merged PR, an open
 * PR, commits naming it with no PR, or nothing.
 */
export type CodeState = 'merged' | 'in-review' | 'committed' | 'none';

/**
 * Jira and GitHub disagreeing about one ticket. GitHub is authoritative for
 * code facts and Jira for workflow, so neither overwrites the other's figure —
 * the disagreement is shown instead.
 *
 * - `github-ahead`: a PR is merged but Jira has not reached its done category
 *   (often "Ready for QA" — QA is work GitHub cannot see).
 * - `jira-ahead`: Jira says done while the ticket's only PRs are still open.
 */
export type SourceClash = 'github-ahead' | 'jira-ahead';

export interface SprintTicketRow {
  key: string;
  title: string;
  type: string;
  /** Jira's status name, as the board shows it. */
  status: string;
  bucket: JiraStatusBucket;
  storyPoints: number | null;
  assigneeName: string | null;
  epicKey: string | null;
  /** The ticket's subtasks in this sprint — counted here, not as work items. */
  subtasks: { total: number; done: number };
  /** From GitHub; a subtask's commits and PRs roll up to its parent. */
  code: {
    state: CodeState;
    prs: { ref: string; state: string; mergedAt: string | null }[];
    /** Authored commits in the sprint window naming the ticket or a subtask. */
    commits: number;
    lastCommitAt: string | null;
  };
  clash: SourceClash | null;
  /** The per-ticket `DataGapKind`s that apply, most actionable first. */
  gaps: DataGapKind[];
}

export interface SprintEpicRow {
  /** Null groups the work items that have no epic. */
  key: string | null;
  title: string | null;
  items: number;
  done: number;
  points: number;
}

/**
 * The sprint's Jira structure for the projects in scope — work items by
 * board column, type and epic — beside what GitHub says about each one.
 */
export interface SprintWorkBreakdownView {
  buckets: Record<JiraStatusBucket, { items: number; points: number }>;
  byType: { type: string; items: number; done: number }[];
  subtasks: { total: number; done: number };
  epics: SprintEpicRow[];
  code: Record<CodeState, number>;
  clashes: { githubAhead: number; jiraAhead: number };
  unestimated: number;
  unassigned: number;
  /** Where Jira lags or misses the GitHub work, most actionable first; empty when none. */
  gaps: DataGapFinding[];
  tickets: SprintTicketRow[];
}

export interface CommitActivityView {
  committers: number;
  assignees: number;
  commits: number;
  commitsPerDay: number | null;
  /** Merge commits in the sprint window, left out of `commits` (METRICS.md §0). */
  mergeCommitsExcluded: number;
  prsRaised: number;
  prsOpen: number;
  prsMerged: number;
  prsReviewed: number;
  reviewedPct: number | null;
  avgHoursToFirstReview: number | null;
  prsWaitingOver24h: number;
  linkage: SprintCommitLinkage;
}

/** A PR waiting this long with no first review is flagged as waiting. */
const REVIEW_WAIT_THRESHOLD_HOURS = 24;

/**
 * How long one sprint's linked work is reused. The sprint-health route asks
 * for it from three panels at once; without this each re-read the window's
 * commits (up to 20,000 rows) and their branches.
 */
const LINKED_WORK_TTL_MS = 30_000;

/**
 * Jira statuses that sit AFTER the code is written — QA, UAT, review, open
 * defects. Merged code there is the expected flow, not a stale Jira.
 */
const QA_STATUS = /\b(qa|test|testing|uat|review|verif\w*|defects?)\b/i;

/**
 * "In progress" category statuses that still mean nobody has started — this
 * tenant's "READY FOR DEVELOPMENT" is in Jira's indeterminate category.
 */
const NOT_STARTED_STATUS = /\bready for (dev\w*|design)\b/i;

/** Keys or repos listed per finding — enough to act on, not a dump. */
const GAP_SAMPLE = 8;

/** Order findings are shown in: what to fix in Jira first, context last. */
const GAP_ORDER: DataGapKind[] = [
  'progress-not-marked',
  'jira-not-updated',
  'done-before-merge',
  'ticket-not-in-sprint',
  'ticket-in-other-sprint',
  'ticket-not-logged',
  'unassigned-with-code',
  'commits-not-tagged',
  'no-code-linked',
  'in-qa',
];

/** Tickets list in-progress first: that is where a reader acts. */
const BUCKET_ORDER: Record<JiraStatusBucket, number> = {
  'in-progress': 0,
  todo: 1,
  done: 2,
};

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
  private readonly linkedWorkCache = new Map<
    string,
    { at: number; work: Promise<LinkedWork> }
  >();

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly planning: PlanningService,
    private readonly code: CodeService,
    private readonly identities: DeveloperIdentityService,
    private readonly correlation: CorrelationService,
  ) {}

  /**
   * Five commit-activity tiles: who committed, PR flow, and review latency —
   * over the sprint's own window and the GitHub work linked to its tickets.
   */
  async commitActivity(
    sprintExternalId: string,
    projects: string[] = [],
  ): Promise<CommitActivityView | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const found = await this.sprintWindow(tenantId, sprintExternalId);
    if (!found) {
      return null;
    }
    const { win } = found;

    const [items, index] = await Promise.all([
      this.planning.listItemsForSprint(tenantId, sprintExternalId, projects),
      this.identities.attributionIndex(tenantId),
    ]);
    const { commits, prs, linkage } = await this.linkedWork(
      tenantId,
      win,
      items,
      projects,
    );

    // Bots, deprovisioned accounts and admin-withheld entities stay OUT of
    // this head-count — it is read against a Jira-assignee denominator ("N of
    // M assigned") that can never contain any of them — but their commits
    // still count in `commits.length` below. Matches `bridgeCoverage`'s rule
    // exactly: excluded from figures that count people, not from the work.
    // Merge commits are out of the commit count (METRICS.md §0) but still mark
    // their author as having committed — merging is real work in the sprint.
    const { authored } = partitionMerges(commits);
    const committers = new Set<string>();
    for (const commit of commits) {
      const person = attributeCommit(commit, index);
      if (
        person &&
        !isBotDeveloper(person) &&
        !isAnonymizedAccount(person) &&
        !index.excluded.has(person)
      ) {
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
      commits: authored.length,
      mergeCommitsExcluded: commits.length - authored.length,
      commitsPerDay:
        win.dayKeys.length > 0
          ? round1(authored.length / win.dayKeys.length)
          : null,
      prsRaised: prs.length,
      prsOpen: prs.filter((pr) => pr.state === 'open').length,
      prsMerged: prs.filter((pr) => pr.state === 'merged').length,
      prsReviewed: reviewed.length,
      reviewedPct: pct(reviewed.length, prs.length),
      avgHoursToFirstReview:
        reviewHours.length > 0 ? round1(mean(reviewHours)) : null,
      prsWaitingOver24h,
      linkage,
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
    const found = await this.sprintWindow(tenantId, sprintExternalId);
    if (!found) {
      return null;
    }
    const { win } = found;

    const [items, index, jiraIndex] = await Promise.all([
      this.planning.listItemsForSprint(tenantId, sprintExternalId, projects),
      this.identities.attributionIndex(tenantId),
      this.identities.jiraAssigneeIndex(tenantId),
    ]);
    // The same ticket-linked commits, PRs and reviews the commit-activity
    // tiles count, so the two panels describe one body of work.
    const { commits, prs, reviews } = await this.linkedWork(
      tenantId,
      win,
      items,
      projects,
    );

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

    // Bots, deprovisioned accounts and admin-withheld entities never become a
    // ROW on this table: it is the one board on the platform that publishes an
    // attributed per-person grade, and a bot (Dependabot raises plenty of PRs)
    // can otherwise land in the top tertile and be graded `high` right next to
    // the humans it's compared against. Matches `bridgeCoverage`'s rule —
    // excluded from figures that count PEOPLE. Their commits still land in
    // `commits`/LOC totals elsewhere (`commitActivity`'s `commits.length`,
    // unaffected).
    const isExcludedPerson = (person: string) =>
      isBotDeveloper(person) ||
      isAnonymizedAccount(person) ||
      // An admin-withheld entity, for the same reason and with more force: a
      // person has looked at it and said it is not a developer. This board is
      // the one that publishes a per-person GRADE, so a wrong row here is
      // attributed to someone by name.
      index.excluded.has(person);

    // Authored commits only: a merge commit's lines are the merged branch's a
    // second time, credited to the merger (METRICS.md §0). This table shows
    // LOC by name, so the double count would land on a named person.
    for (const commit of partitionMerges(commits).authored) {
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
    // `win.from`/`win.to` are never read below — only `sprint.projectKey` —
    // so this reaches the sprint directly rather than through
    // `sprintWindow()`. That also lifts its `!sprint?.startAt` gate, which this panel does not need: a sprint with
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
   * The sprint's Jira structure for the projects in scope, each work item
   * beside what GitHub says about its code.
   *
   * Work items are counted as Jira's sprint counts them — no epics, no
   * subtasks — and "done" is Jira's status category, so the column totals
   * match the board. Subtasks roll up into their parent; epics group.
   *
   * GitHub is the source for code facts (PR state, commits, merge time) and
   * Jira for workflow (status, done, points). Where they disagree the row
   * carries a `clash` rather than one silently overwriting the other.
   */
  async workBreakdown(
    sprintExternalId: string,
    projects: string[] = [],
  ): Promise<SprintWorkBreakdownView | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const found = await this.sprintWindow(tenantId, sprintExternalId);
    if (!found) {
      return null;
    }
    const all = await this.planning.listItemsForSprint(
      tenantId,
      sprintExternalId,
      projects,
    );
    const {
      commits,
      allPrs,
      refsByStory,
      ticketsBySha,
      offSprintKeys,
      otherSprintKeys,
      unknownKeys,
      untaggedByRepo,
      linkage,
    } = await this.linkedWork(tenantId, found.win, all, projects);

    const workItems = all.filter(
      (i) => i.type !== 'epic' && i.type !== 'subtask',
    );
    const workKeys = new Set(workItems.map((i) => i.externalKey));
    // A subtask's code is its parent's code. One whose parent is not a work
    // item in scope is not shown — Jira's sprint view nests it the same way.
    const ownerOf = new Map<string, string>(
      workItems.map((i) => [i.externalKey, i.externalKey]),
    );
    const subtaskCount = new Map<string, { total: number; done: number }>();
    for (const sub of all) {
      if (sub.type !== 'subtask' || !sub.parentKey) continue;
      if (!workKeys.has(sub.parentKey)) continue;
      ownerOf.set(sub.externalKey, sub.parentKey);
      const c = subtaskCount.get(sub.parentKey) ?? { total: 0, done: 0 };
      c.total += 1;
      if (isJiraDone(sub)) c.done += 1;
      subtaskCount.set(sub.parentKey, c);
    }

    const prByRef = new Map(
      allPrs.map((pr) => [
        `${pr.repoFullName}#${pr.externalNumber}`.toLowerCase(),
        pr,
      ]),
    );
    const prRefsOf = new Map<string, Set<string>>();
    for (const item of all) {
      const owner = ownerOf.get(item.externalKey);
      if (!owner) continue;
      const refs = prRefsOf.get(owner) ?? new Set<string>();
      for (const ref of refsByStory.get(item.id) ?? []) {
        refs.add(ref.toLowerCase());
      }
      prRefsOf.set(owner, refs);
    }
    const commitsOf = new Map<string, { n: number; last: Date | null }>();
    for (const commit of partitionMerges(commits).authored) {
      const owners = new Set(
        (ticketsBySha.get(commit.sha) ?? [])
          .map((k) => ownerOf.get(k))
          .filter((k): k is string => Boolean(k)),
      );
      for (const owner of owners) {
        const c = commitsOf.get(owner) ?? { n: 0, last: null };
        c.n += 1;
        if (commit.committedAt && (!c.last || commit.committedAt > c.last)) {
          c.last = commit.committedAt;
        }
        commitsOf.set(owner, c);
      }
    }

    const tickets: SprintTicketRow[] = workItems.map((item) => {
      const prs = [...(prRefsOf.get(item.externalKey) ?? [])]
        .map((ref) => prByRef.get(ref))
        .filter((pr): pr is PullRequest => Boolean(pr))
        .sort(
          (a, b) =>
            a.repoFullName.localeCompare(b.repoFullName) ||
            Number(a.externalNumber) - Number(b.externalNumber),
        );
      const c = commitsOf.get(item.externalKey) ?? { n: 0, last: null };
      const state: CodeState = prs.some((pr) => pr.state === 'merged')
        ? 'merged'
        : prs.some((pr) => pr.state === 'open')
          ? 'in-review'
          : c.n > 0
            ? 'committed'
            : 'none';
      const bucket = bucketOf(item);
      return {
        key: item.externalKey,
        title: item.title,
        type: item.type,
        status: item.status,
        bucket,
        storyPoints: item.storyPoints,
        assigneeName: item.assigneeName,
        epicKey: item.epicKey,
        subtasks: subtaskCount.get(item.externalKey) ?? { total: 0, done: 0 },
        code: {
          state,
          prs: prs.map((pr) => ({
            ref: `${pr.repoFullName}#${pr.externalNumber}`,
            state: pr.state,
            mergedAt: pr.mergedAt ? pr.mergedAt.toISOString() : null,
          })),
          commits: c.n,
          lastCommitAt: c.last ? c.last.toISOString() : null,
        },
        clash:
          bucket !== 'done' && state === 'merged'
            ? 'github-ahead'
            : bucket === 'done' && state === 'in-review'
              ? 'jira-ahead'
              : null,
        gaps: ticketGaps(
          item,
          bucket,
          state,
          prs.some((pr) => pr.state === 'open'),
        ),
      };
    });
    tickets.sort(
      (a, b) =>
        BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] ||
        compareKeys(a.key, b.key),
    );

    const buckets: SprintWorkBreakdownView['buckets'] = {
      todo: { items: 0, points: 0 },
      'in-progress': { items: 0, points: 0 },
      done: { items: 0, points: 0 },
    };
    const byType = new Map<string, { items: number; done: number }>();
    const epicAgg = new Map<string | null, SprintEpicRow>();
    const code: Record<CodeState, number> = {
      merged: 0,
      'in-review': 0,
      committed: 0,
      none: 0,
    };
    for (const t of tickets) {
      const done = t.bucket === 'done';
      buckets[t.bucket].items += 1;
      buckets[t.bucket].points += t.storyPoints ?? 0;
      const ty = byType.get(t.type) ?? { items: 0, done: 0 };
      ty.items += 1;
      if (done) ty.done += 1;
      byType.set(t.type, ty);
      const e = epicAgg.get(t.epicKey) ?? {
        key: t.epicKey,
        title: null,
        items: 0,
        done: 0,
        points: 0,
      };
      e.items += 1;
      if (done) e.done += 1;
      e.points += t.storyPoints ?? 0;
      epicAgg.set(t.epicKey, e);
      code[t.code.state] += 1;
    }
    const epicKeys = [...epicAgg.keys()].filter((k): k is string => k !== null);
    const epicTitles = new Map(
      (await this.planning.findByKeys(tenantId, epicKeys)).map((e) => [
        e.externalKey,
        e.title,
      ]),
    );
    const epics = [...epicAgg.values()]
      .map((e) => ({
        ...e,
        title: e.key ? (epicTitles.get(e.key) ?? null) : null,
      }))
      // Biggest epics first; "no epic" last, however big it is.
      .sort(
        (a, b) =>
          Number(a.key === null) - Number(b.key === null) ||
          b.items - a.items ||
          compareKeys(a.key ?? '', b.key ?? ''),
      );

    const counted = [...subtaskCount.values()];
    return {
      buckets,
      byType: [...byType]
        .map(([type, v]) => ({ type, ...v }))
        .sort((a, b) => b.items - a.items || a.type.localeCompare(b.type)),
      subtasks: {
        total: counted.reduce((s, c) => s + c.total, 0),
        done: counted.reduce((s, c) => s + c.done, 0),
      },
      epics,
      code,
      clashes: {
        githubAhead: tickets.filter((t) => t.clash === 'github-ahead').length,
        jiraAhead: tickets.filter((t) => t.clash === 'jira-ahead').length,
      },
      unestimated: tickets.filter((t) => t.storyPoints === null).length,
      unassigned: tickets.filter((t) => !t.assigneeName).length,
      gaps: dataGaps(tickets, {
        offSprintKeys,
        otherSprintKeys,
        unknownKeys,
        // Untagged commits are scoped to the repos this sprint's linked work
        // landed in — a commit naming no ticket can't be placed in a project
        // any other way, and the tenant-wide figure is not this team's.
        untaggedByRepo: new Map(
          [...untaggedByRepo].filter(([repo]) =>
            linkage.reposTouched.includes(repo),
          ),
        ),
      }),
      tickets,
    };
  }

  /**
   * The sprint's own elapsed window, clamped to now. A running sprint is
   * measured over the days it has actually had, not the days it was allotted:
   * averaging 14 days of commits over a 21-day plan understates a team
   * mid-sprint.
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
   * The GitHub work that belongs to this sprint: commits whose message or
   * branch names one of `items`, the PRs implementing them, and the reviews
   * on those PRs — all inside the sprint's window.
   *
   * Linked by ticket, not by repository. Mapping repos to projects (a repo
   * counted if any of its PRs ever linked to the project) credited a shared
   * repo's every commit to every project that had touched it: on the
   * reference tenant ACT mapped to 87 repos holding 1,027 of November's
   * 1,243 commits, and NHC to 32 holding 631, overlapping heavily. A commit
   * naming no ticket cannot be placed this way, so it is counted in
   * `noTicketCommits` rather than guessed at.
   */
  private linkedWork(
    tenantId: string,
    win: SprintWindowDates,
    items: Story[],
    projects: string[],
  ): Promise<LinkedWork> {
    const now = Date.now();
    for (const [k, v] of this.linkedWorkCache) {
      if (now - v.at > LINKED_WORK_TTL_MS) this.linkedWorkCache.delete(k);
    }
    const key = [
      tenantId,
      win.from.getTime(),
      [...projects].sort().join(','),
      items
        .map((item) => item.id)
        .sort()
        .join(','),
    ].join('|');
    const hit = this.linkedWorkCache.get(key);
    if (hit) {
      return hit.work;
    }
    const work = this.computeLinkedWork(tenantId, win, items, projects);
    this.linkedWorkCache.set(key, { at: now, work });
    work.catch(() => this.linkedWorkCache.delete(key));
    return work;
  }

  private async computeLinkedWork(
    tenantId: string,
    win: SprintWindowDates,
    items: Story[],
    projects: string[],
  ): Promise<LinkedWork> {
    const sprintKeys = new Set(items.map((item) => item.externalKey));
    const [page, refsByStory] = await Promise.all([
      this.code.listCommitsPage(tenantId, { from: win.from, to: win.to }),
      this.correlation.prRefsByStoryId(
        tenantId,
        items.map((item) => item.id),
      ),
    ]);

    // Keys are read across every copy of a commit before copies collapse: a
    // copied repo holds the same SHA, and its branches can name the ticket
    // when the original's do not.
    const links = await this.code.branchesForCommits(tenantId, page.commits);
    const keysById = ticketKeysByCommit(page.commits, links);
    const keysBySha = new Map<string, Map<string, Set<string>>>();
    for (const c of page.commits) {
      const merged = keysBySha.get(c.sha) ?? new Map<string, Set<string>>();
      for (const [key, sources] of keysById.get(`${c.repoFullName}@${c.sha}`) ??
        []) {
        const into = merged.get(key) ?? new Set<string>();
        for (const s of sources) into.add(s);
        merged.set(key, into);
      }
      keysBySha.set(c.sha, merged);
    }

    // Keys outside the sprint are resolved only to tell "another ticket of
    // this project" apart from "a key Jira does not know" (`UTF-8`, a typo).
    const outside = candidateTicketKeys(keysById).filter(
      (key) => !sprintKeys.has(key),
    );
    const known = await this.planning.findByKeys(tenantId, outside);
    const inScope = new Set(
      known
        .filter((s) => projects.length === 0 || projects.includes(s.projectKey))
        .map((s) => s.externalKey),
    );
    const knownKeys = new Set(known.map((s) => s.externalKey));

    const { commits } = distinctCommitsBySha(page.commits);
    const linked: Commit[] = [];
    const ticketsBySha = new Map<string, string[]>();
    const repos = new Set<string>();
    let linkedViaBranchOnly = 0;
    let otherTicketCommits = 0;
    let noTicketCommits = 0;
    const offSprintKeys = new Map<string, number>();
    const otherSprintKeys = new Map<string, number>();
    const sprintOf = new Map(
      known.map((s) => [s.externalKey, s.sprintExternalId]),
    );
    const unknownKeys = new Map<string, number>();
    const untaggedByRepo = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string) =>
      m.set(k, (m.get(k) ?? 0) + 1);
    const inProjects = (key: string) =>
      projects.includes(key.split('-')[0] ?? '');
    for (const commit of commits) {
      const keys = keysBySha.get(commit.sha) ?? new Map<string, Set<string>>();
      const hits = [...keys].filter(([key]) => sprintKeys.has(key));
      if (hits.length > 0) {
        linked.push(commit);
        ticketsBySha.set(
          commit.sha,
          hits.map(([key]) => key),
        );
        repos.add(commit.repoFullName);
        continue;
      }
      // The disclosure counts are over authored commits, like the tiles.
      if (isMergeCommit(commit)) continue;
      const named = [...keys.keys()];
      if (named.some((key) => inScope.has(key))) {
        otherTicketCommits += 1;
        for (const key of named) {
          if (!inScope.has(key)) continue;
          bump(sprintOf.get(key) ? otherSprintKeys : offSprintKeys, key);
        }
      } else if (!named.some((key) => knownKeys.has(key))) {
        noTicketCommits += 1;
        const unknown = named.filter(inProjects);
        for (const key of unknown) bump(unknownKeys, key);
        if (named.length === 0) bump(untaggedByRepo, commit.repoFullName);
      }
    }
    for (const commit of partitionMerges(linked).authored) {
      const keys = keysBySha.get(commit.sha)!;
      const byMessage = [...keys].some(
        ([key, sources]) => sprintKeys.has(key) && sources.has('message'),
      );
      if (!byMessage) linkedViaBranchOnly += 1;
    }

    const refs = [...new Set([...refsByStory.values()].flat())];
    const allPrs = await this.code.listPullRequestsByRefs(tenantId, refs);
    const reviews =
      allPrs.length > 0
        ? await this.prisma.prReview.findMany({
            where: {
              tenantId,
              submittedAt: { gte: win.from, lte: win.to },
              OR: allPrs.map((pr) => ({
                repoFullName: pr.repoFullName,
                externalNumber: pr.externalNumber,
              })),
            },
          })
        : [];

    return {
      commits: linked,
      prs: allPrs.filter(
        (pr) => pr.openedAt && pr.openedAt >= win.from && pr.openedAt <= win.to,
      ),
      reviews,
      allPrs,
      refsByStory,
      ticketsBySha,
      offSprintKeys,
      otherSprintKeys,
      unknownKeys,
      untaggedByRepo,
      linkage: {
        sprintTickets: sprintKeys.size,
        linkedCommits: partitionMerges(linked).authored.length,
        linkedViaBranchOnly,
        otherTicketCommits,
        noTicketCommits,
        reposTouched: [...repos].sort(),
        truncated: page.truncated,
      },
    };
  }
}

/** The per-ticket `DataGapKind`s for one work item, most actionable first. */
function ticketGaps(
  item: Story,
  bucket: JiraStatusBucket,
  state: CodeState,
  hasOpenPr: boolean,
): DataGapKind[] {
  const gaps: DataGapKind[] = [];
  const hasCode = state !== 'none';
  const notStarted =
    bucket === 'todo' ||
    (bucket === 'in-progress' && NOT_STARTED_STATUS.test(item.status));
  const inQa = bucket === 'in-progress' && QA_STATUS.test(item.status);
  if (hasCode && notStarted) {
    gaps.push('progress-not-marked');
  } else if (bucket === 'in-progress' && state === 'merged') {
    // An open PR beside the merged one means development is still going.
    if (inQa) gaps.push('in-qa');
    else if (!hasOpenPr) gaps.push('jira-not-updated');
  }
  if (bucket === 'done' && state === 'in-review') {
    gaps.push('done-before-merge');
  }
  if (hasCode && !item.assigneeName) {
    gaps.push('unassigned-with-code');
  }
  if (bucket === 'in-progress' && !notStarted && !inQa && !hasCode) {
    gaps.push('no-code-linked');
  }
  return gaps;
}

/** Per-ticket gaps rolled up, plus the sprint-wide ones read from commits. */
function dataGaps(
  tickets: SprintTicketRow[],
  commits: {
    offSprintKeys: Map<string, number>;
    otherSprintKeys: Map<string, number>;
    unknownKeys: Map<string, number>;
    untaggedByRepo: Map<string, number>;
  },
): DataGapFinding[] {
  const out: DataGapFinding[] = [];
  const perTicket = new Map<DataGapKind, string[]>();
  for (const t of tickets) {
    for (const g of t.gaps)
      perTicket.set(g, [...(perTicket.get(g) ?? []), t.key]);
  }
  for (const [kind, keys] of perTicket) {
    out.push({
      kind,
      severity:
        kind === 'in-qa' || kind === 'no-code-linked' ? 'info' : 'action',
      count: keys.length,
      commits: null,
      sample: keys.slice(0, GAP_SAMPLE),
    });
  }
  const fromCommits = (
    kind: DataGapKind,
    m: Map<string, number>,
  ): DataGapFinding | null => {
    if (m.size === 0) return null;
    const ranked = [...m].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    return {
      kind,
      severity: 'action',
      count: m.size,
      commits: ranked.reduce((s, [, n]) => s + n, 0),
      sample: ranked.slice(0, GAP_SAMPLE).map(([k]) => k),
    };
  };
  for (const f of [
    fromCommits('ticket-not-in-sprint', commits.offSprintKeys),
    fromCommits('ticket-in-other-sprint', commits.otherSprintKeys),
    fromCommits('ticket-not-logged', commits.unknownKeys),
    fromCommits('commits-not-tagged', commits.untaggedByRepo),
  ]) {
    if (f) out.push(f);
  }
  return out.sort(
    (a, b) => GAP_ORDER.indexOf(a.kind) - GAP_ORDER.indexOf(b.kind),
  );
}

/** Jira's board column for an item, from its status category. */
function bucketOf(item: Story): JiraStatusBucket {
  if (isJiraDone(item)) return 'done';
  return item.statusCategory === 'indeterminate' ? 'in-progress' : 'todo';
}

/** `NHC-9` before `NHC-10`: project, then issue number. */
function compareKeys(a: string, b: string): number {
  const [pa, na] = a.split('-');
  const [pb, nb] = b.split('-');
  return (pa ?? '').localeCompare(pb ?? '') || Number(na) - Number(nb);
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
