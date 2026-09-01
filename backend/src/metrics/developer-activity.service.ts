import { Injectable } from '@nestjs/common';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { istDateKey } from '../common/time';
import {
  DeveloperIdentityService,
  JiraAssigneeCoverage,
} from '../correlation/developer-identity.service';
import {
  isAnonymizedAccount,
  isBotDeveloper,
  type MatchSuggestion,
} from '../correlation/developer-identity.util';
import { PrismaService } from '../database/prisma.service';
import { CodeService } from '../modules/code/code.service';

/**
 * Read models for the Engineering Activity section (DASHBOARDS.md §4.4).
 *
 * Its own service rather than more of `InsightsService`, which is already past
 * 1,800 lines: these four pages share one vocabulary — a person, their last
 * signal, and whether the plan knows about them — that the sprint/velocity
 * read models have no use for.
 *
 * Every figure here is team-shaped or evidence-shaped by construction. Nothing
 * in this file sorts people by volume, and the one ordering that could be read
 * as a ranking (the review queue) is ordered by how long a PULL REQUEST has
 * waited, which is a property of the change, not of its author.
 */

/** Recency buckets, in IST working days (Mon–Fri), per DASHBOARDS.md §4.4.2. */
export const WATCHLIST_ACTIVE_WITHIN_WORKING_DAYS = 7;
export const WATCHLIST_QUIET_WITHIN_WORKING_DAYS = 30;

/** A PR unreviewed for longer than this is called out on PR Status. */
export const REVIEW_WAIT_ALERT_HOURS = 48;

export type SignalType = 'commit' | 'pr_opened' | 'pr_merged' | 'pr_reviewed';

export type WatchlistBucket = 'active' | 'quiet' | 'no_signal';

export interface LastSignal {
  type: SignalType;
  at: string;
}

export interface WatchlistDeveloper {
  developer: string;
  displayName: string;
  /** Projects reached through the delivery graph, via the repos they touched. */
  projects: string[];
  lastSignal: LastSignal | null;
  bucket: WatchlistBucket;
  /**
   * Whether any Jira item is assigned to this person right now. `null` means
   * the bridge never matched them — which is NOT the same as "nothing
   * assigned", and must never render as it.
   */
  hasAssignedWork: boolean | null;
  /** Open items assigned to them; absent when `hasAssignedWork` is null. */
  assignedOpenItems?: number;
}

export interface WatchlistExclusionView {
  developer: string;
  displayName: string;
  reason: string;
  expiresAt: string;
}

export interface WatchlistView {
  developers: WatchlistDeveloper[];
  counts: Record<WatchlistBucket, number>;
  /**
   * Committing in the window with no Jira item assigned — the planning gap.
   * Only ever populated for people the Jira bridge actually matched.
   */
  committingWithoutAssignedWork: WatchlistDeveloper[];
  excluded: WatchlistExclusionView[];
  /**
   * Developers nothing linked automatically, each with the names that might be
   * them. Suggestions only — displayed for a person to read, never applied
   * (DASHBOARDS.md §4.4.6).
   */
  unlinked: {
    developer: string;
    displayName: string;
    suggestions: MatchSuggestion[];
  }[];
  /**
   * Accounts GitHub anonymized on deprovision — reported, never bucketed.
   *
   * Shown rather than filtered for the same reason the exclusion list is
   * published: a roster that quietly drops a category of account is one nobody
   * can audit. But they are kept out of the attention buckets, because
   * "no tracked activity" against a decommissioned account invites someone to
   * go check on a person who has left (DASHBOARDS.md §4.4.7).
   */
  inactiveAccounts: {
    developer: string;
    /** PRs authored, ever — evidence the account did real work before it went. */
    prsAuthored: number;
    lastSignal: LastSignal | null;
  }[];
  /** How far the Jira↔GitHub bridge reaches. Published, never assumed. */
  assigneeCoverage: JiraAssigneeCoverage;
  thresholds: {
    activeWithinWorkingDays: number;
    quietWithinWorkingDays: number;
  };
  windowDays: number;
  computedAt: string;
}

export interface OverviewView {
  totals: {
    commits: number;
    /** Developers with any tracked signal in the window. */
    developersWithSignal: number;
    /** Developers known to the tenant at all — the honest denominator. */
    developersKnown: number;
    prsOpened: number;
    prsMerged: number;
    /** Committing with nothing assigned; null when the bridge matched nobody. */
    committingWithoutAssignedWork: number | null;
  };
  /** Commits per IST day, with that day's contributors for the drill-down. */
  days: {
    date: string;
    totalCommits: number;
    developers: { developer: string; displayName: string; commits: number }[];
    unattributedCommits: number;
  }[];
  attribution: {
    commitsInScope: number;
    commitsUnattributed: number;
    coveragePct: number | null;
    unattributedIdentities: number;
  };
  assigneeCoverage: JiraAssigneeCoverage;
  truncated: boolean;
  windowDays: number;
  computedAt: string;
}

export interface WaitingPr {
  ref: string;
  repo: string;
  number: string;
  title: string;
  author: string | null;
  projects: string[];
  additions: number;
  deletions: number;
  openedAt: string;
  waitingHours: number;
  /** No review of any kind yet — distinct from "reviewed, still open". */
  neverReviewed: boolean;
}

export interface ReviewLoadRow {
  developer: string;
  displayName: string;
  prsRaised: number;
  prsReviewed: number;
  /** Hours their oldest unreviewed PR has waited. A fact, not an average. */
  oldestWaitingHours: number | null;
}

export interface PrStatusView {
  totals: {
    open: number;
    waitingOverThreshold: number;
    neverReviewed: number;
    reviewsGiven: number;
    /** Automated reviews, excluded from `reviewsGiven` and every row below. */
    botReviews: number;
  };
  waiting: WaitingPr[];
  reviewLoad: ReviewLoadRow[];
  /**
   * Open PRs whose review timeline was never fetched. They cannot be called
   * unreviewed — that would indict collection lag as a review failure.
   */
  excludedNoReviewData: number;
  thresholdHours: number;
  windowDays: number;
  computedAt: string;
}

export interface AssignedItem {
  key: string;
  projectKey: string;
  type: string;
  status: string;
  title: string;
  /** Committed to a sprint, as opposed to sitting in the backlog assigned. */
  inSprint: boolean;
}

export interface DeveloperContextView {
  /** Non-bot reviews this person submitted in the window. */
  prsReviewed: number;
  /**
   * Null when the Jira bridge never matched this developer. Rendering that as
   * an empty item list would assert they have no assigned work, which is a
   * different claim from "we could not tell".
   */
  assignment: {
    openItems: AssignedItem[];
    /** The Jira account references the items were gathered under. */
    jiraRefs: string[];
  } | null;
  assigneeCoverage: JiraAssigneeCoverage;
}

@Injectable()
export class DeveloperActivityService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly code: CodeService,
    private readonly identities: DeveloperIdentityService,
  ) {}

  /**
   * Team-shaped summary: how much landed, from how many people, and how much
   * of it can be trusted.
   *
   * Deliberately carries no per-developer roster. The Watchlist owns people;
   * duplicating the roster here is what made the original mockup render one
   * dataset as two pages (DASHBOARDS.md §4.4.1).
   */
  async overview(
    repos: string[],
    from: Date,
    to: Date,
    windowDays: number,
  ): Promise<OverviewView> {
    const tenantId = this.tenantContext.requireTenantId();
    const [{ commits, truncated }, index, attribution, assignees, prs] =
      await Promise.all([
        this.code.listCommitsPage(tenantId, {
          ...(repos.length > 0 ? { repos } : {}),
          from,
          to,
        }),
        this.identities.attributionIndex(tenantId),
        this.identities.attributionCoverage(tenantId, from, to, repos),
        this.identities.jiraAssigneeIndex(tenantId),
        this.prisma.pullRequest.findMany({
          where: {
            tenantId,
            ...(repos.length > 0 ? { repoFullName: { in: repos } } : {}),
            openedAt: { gte: from, lte: to },
          },
          select: { authorLogin: true, mergedAt: true },
        }),
      ]);

    interface DayAcc {
      total: number;
      unattributed: number;
      byDeveloper: Map<string, number>;
    }
    const byDay = new Map<string, DayAcc>();
    const withSignal = new Set<string>();
    const committers = new Set<string>();

    for (const c of commits) {
      const day = istDateKey(c.committedAt ?? c.authoredAt);
      const acc = byDay.get(day) ?? {
        total: 0,
        unattributed: 0,
        byDeveloper: new Map<string, number>(),
      };
      acc.total += 1;
      const person = attributeCommit(c, index);
      if (person) {
        acc.byDeveloper.set(person, (acc.byDeveloper.get(person) ?? 0) + 1);
        withSignal.add(person);
        committers.add(person);
      } else {
        acc.unattributed += 1;
      }
      byDay.set(day, acc);
    }

    let prsMerged = 0;
    for (const pr of prs) {
      if (pr.mergedAt) {
        prsMerged += 1;
      }
      if (pr.authorLogin) {
        withSignal.add(index.byLogin.get(pr.authorLogin) ?? pr.authorLogin);
      }
    }

    // Same definition the Watchlist reports, via the same function — these two
    // numbers are the same claim on two pages and disagreed on real data while
    // they were computed separately (see `planningGapDevelopers`).
    //
    // `null`, not 0, when the bridge matched nobody: with no matches the gap is
    // unknowable, and a 0 would read as "everyone has assigned work".
    const openAssigned = await this.openAssignedByDeveloper(
      tenantId,
      assignees.byDeveloper,
    );
    const coverage = this.identities.bridgeCoverage(committers, assignees);
    const withoutAssignedWork =
      assignees.assignees.matched === 0
        ? null
        : planningGapDevelopers(
            committers,
            new Set(assignees.byDeveloper.keys()),
            openAssigned,
          ).length;

    return {
      totals: {
        commits: commits.length,
        developersWithSignal: withSignal.size,
        developersKnown: index.displayNames.size,
        prsOpened: prs.length,
        prsMerged,
        committingWithoutAssignedWork: withoutAssignedWork,
      },
      days: [...byDay.entries()]
        .map(([date, acc]) => ({
          date,
          totalCommits: acc.total,
          developers: [...acc.byDeveloper.entries()]
            .map(([developer, count]) => ({
              developer,
              displayName: index.displayNames.get(developer) ?? developer,
              commits: count,
            }))
            // Alphabetical (CLAUDE.md — no volume ranking). The UI's
            // "Most commits" toggle is the reader's explicit act, never this.
            .sort((a, b) => a.displayName.localeCompare(b.displayName)),
          unattributedCommits: acc.unattributed,
        }))
        .sort((a, b) => b.date.localeCompare(a.date)),
      attribution: {
        commitsInScope: attribution.commitsInScope,
        commitsUnattributed: attribution.commitsUnattributed,
        coveragePct: attribution.coveragePct,
        unattributedIdentities: attribution.unattributedIdentities,
      },
      assigneeCoverage: coverage,
      truncated,
      windowDays,
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * Who has shown no tracked signal lately, and who is committing outside the
   * plan. A prompt to ask a question — never a conclusion about anyone.
   *
   * Two orthogonal lenses on purpose. Recency and assignment are independent:
   * an *active* developer with nothing assigned is exactly the case worth
   * seeing, and folding assignment into the buckets would bury them.
   *
   * "Working days" throughout: a Friday commit does not make someone quiet by
   * Monday, and a calendar-day threshold silently makes every weekend look
   * like a two-day lull across the whole roster.
   */
  async watchlist(
    from: Date,
    to: Date,
    windowDays: number,
  ): Promise<WatchlistView> {
    const tenantId = this.tenantContext.requireTenantId();
    const [index, assignees, exclusionRows] = await Promise.all([
      this.identities.attributionIndex(tenantId),
      this.identities.jiraAssigneeIndex(tenantId),
      this.prisma.watchlistExclusion.findMany({
        // Live exclusions only — a lapsed one is not a statement about today.
        where: { tenantId, expiresAt: { gt: new Date() } },
      }),
    ]);

    // Everything on this page describes ONE moment. For a preset that moment
    // is now; for a range ending in the past it is the range's end, or the
    // recency buckets would answer "who is quiet today" beside commits from
    // April and present the pair as one finding.
    const now = new Date();
    const asOf = to < now ? to : now;

    const [lastSignals, openAssigned] = await Promise.all([
      this.lastSignalPerDeveloper(tenantId, index, asOf),
      this.openAssignedByDeveloper(tenantId, assignees.byDeveloper),
    ]);
    const excludedIds = new Set(
      exclusionRows.map((row) => row.canonicalDeveloperId),
    );

    // Commits inside the window drive the planning-gap lens; the recency lens
    // deliberately looks further back than the window, because "no signal in
    // 30 days" is unanswerable from a 7-day read.
    const windowCommitters = await this.committersBetween(
      tenantId,
      index,
      from,
      to,
    );

    const anonymized: string[] = [];
    const developers: WatchlistDeveloper[] = [];
    for (const [developer, displayName] of index.displayNames) {
      if (excludedIds.has(developer)) {
        continue;
      }
      // Automation is not a colleague anyone should be prompted to check on.
      // `dependabot[bot]` was landing in these buckets as a developer — and
      // would eventually have surfaced under "no tracked activity", inviting
      // someone to go ask a robot how it was getting on.
      if (isBotDeveloper(developer)) {
        continue;
      }
      // Same shape of error, different cause: an account GitHub anonymized on
      // deprovision has no person behind it to check on. Collected below and
      // reported separately rather than dropped.
      if (isAnonymizedAccount(developer)) {
        anonymized.push(developer);
        continue;
      }
      const lastSignal = lastSignals.get(developer) ?? null;
      // `matched` gates everything about assignment. Unmatched means the
      // bridge never reached this person, which reads identically to "nothing
      // assigned" and means the opposite — so it stays null, not false.
      const matched = assignees.byDeveloper.has(developer);
      const openItems = openAssigned.get(developer) ?? 0;
      developers.push({
        developer,
        displayName,
        projects: [],
        lastSignal: lastSignal
          ? { type: lastSignal.type, at: lastSignal.at.toISOString() }
          : null,
        bucket: bucketFor(lastSignal?.at ?? null, asOf),
        hasAssignedWork: matched ? openItems > 0 : null,
        ...(matched ? { assignedOpenItems: openItems } : {}),
      });
    }

    // Alphabetical, always. These are people, and any volume ordering here
    // would turn a prompt-to-ask into the leaderboard CLAUDE.md forbids.
    developers.sort((a, b) => a.displayName.localeCompare(b.displayName));

    // Only for people who actually committed in the window: suggesting matches
    // for someone with no activity is noise about a person nobody is looking
    // at, and the list is meant to be short enough to act on.
    const unlinkedDevelopers = developers.filter(
      (dev) =>
        windowCommitters.has(dev.developer) &&
        !assignees.byDeveloper.has(dev.developer),
    );
    const suggestions = await this.identities.suggestionsFor(
      tenantId,
      unlinkedDevelopers.map((dev) => ({
        developer: dev.developer,
        displayName: dev.displayName,
      })),
    );
    const unlinked = unlinkedDevelopers.map((dev) => ({
      developer: dev.developer,
      displayName: dev.displayName,
      suggestions: suggestions.get(dev.developer) ?? [],
    }));

    // PR counts are the one fact that makes a deprovisioned account worth
    // looking at: an account with 83 merged PRs behind it did real work whose
    // history someone may still want attributed. Counted over ALL time, not
    // the window — by definition these have no recent activity, and a window
    // figure would render every one of them as a uniform zero.
    const inactiveAccounts = await Promise.all(
      anonymized.sort().map(async (developer) => ({
        developer,
        prsAuthored: await this.prisma.pullRequest.count({
          where: { tenantId, authorLogin: developer },
        }),
        lastSignal: (() => {
          const signal = lastSignals.get(developer);
          return signal
            ? { type: signal.type, at: signal.at.toISOString() }
            : null;
        })(),
      })),
    );

    const counts: Record<WatchlistBucket, number> = {
      active: 0,
      quiet: 0,
      no_signal: 0,
    };
    for (const dev of developers) {
      counts[dev.bucket] += 1;
    }

    return {
      developers,
      counts,
      // Shares its definition with Overview's tile (`planningGapDevelopers`),
      // which is the only thing keeping the two pages' figures identical.
      committingWithoutAssignedWork: (() => {
        const gap = new Set(
          planningGapDevelopers(
            windowCommitters,
            new Set(assignees.byDeveloper.keys()),
            openAssigned,
          ),
        );
        return developers.filter((dev) => gap.has(dev.developer));
      })(),
      excluded: exclusionRows
        .map((row) => ({
          developer: row.canonicalDeveloperId,
          displayName:
            index.displayNames.get(row.canonicalDeveloperId) ??
            row.canonicalDeveloperId,
          reason: row.reason,
          expiresAt: row.expiresAt.toISOString(),
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      unlinked,
      inactiveAccounts,
      assigneeCoverage: this.identities.bridgeCoverage(
        windowCommitters,
        assignees,
      ),
      thresholds: {
        activeWithinWorkingDays: WATCHLIST_ACTIVE_WITHIN_WORKING_DAYS,
        quietWithinWorkingDays: WATCHLIST_QUIET_WITHIN_WORKING_DAYS,
      },
      windowDays,
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * The review queue: what is waiting, and how review load is spread.
   *
   * Reports no cycle-time percentiles — those are Efficiency's, over a
   * merged-only denominator, and restating them here under a different
   * denominator would put two numbers for one concept on two screens
   * (DASHBOARDS.md §4.4.4).
   */
  async prStatus(
    repos: string[],
    from: Date,
    to: Date,
    windowDays: number,
  ): Promise<PrStatusView> {
    const tenantId = this.tenantContext.requireTenantId();
    const repoFilter = repos.length > 0 ? { repoFullName: { in: repos } } : {};

    const [openPrs, windowPrs, index] = await Promise.all([
      // Open PRs are NOT windowed: a PR opened four months ago and still
      // unreviewed is the single most actionable row this page can carry, and
      // a `from` filter is exactly what would hide it.
      this.prisma.pullRequest.findMany({
        where: { tenantId, ...repoFilter, state: 'open' },
        orderBy: { openedAt: 'asc' },
        take: 500,
      }),
      this.prisma.pullRequest.findMany({
        where: { tenantId, ...repoFilter, openedAt: { gte: from, lte: to } },
        select: { authorLogin: true },
      }),
      this.identities.attributionIndex(tenantId),
    ]);

    const reviews = await this.prisma.prReview.findMany({
      where: { tenantId, ...repoFilter, submittedAt: { gte: from, lte: to } },
      select: { reviewerLogin: true, isBot: true },
    });

    const now = new Date();
    const waiting: WaitingPr[] = [];
    let neverReviewed = 0;
    let waitingOverThreshold = 0;
    let excludedNoReviewData = 0;
    const oldestWaitByDeveloper = new Map<string, number>();

    for (const pr of openPrs) {
      if (!pr.openedAt) {
        // No opened date, no wait to measure. Excluded rather than dated from
        // `createdAt`, which is when WE inserted the row, not when it opened.
        continue;
      }
      if (!pr.reviewsFetchedAt) {
        // "Never asked" is not "never reviewed" — the discriminator the
        // schema keeps `reviewsFetchedAt` for.
        excludedNoReviewData += 1;
        continue;
      }
      const isUnreviewed = !pr.firstReviewAt;
      const waitingHours = hoursBetween(pr.openedAt, now);
      if (isUnreviewed) {
        neverReviewed += 1;
        if (waitingHours >= REVIEW_WAIT_ALERT_HOURS) {
          waitingOverThreshold += 1;
        }
        const person = pr.authorLogin
          ? (index.byLogin.get(pr.authorLogin) ?? pr.authorLogin)
          : null;
        if (person) {
          oldestWaitByDeveloper.set(
            person,
            Math.max(oldestWaitByDeveloper.get(person) ?? 0, waitingHours),
          );
        }
        waiting.push({
          ref: `${pr.repoFullName}#${pr.externalNumber}`,
          repo: pr.repoFullName,
          number: pr.externalNumber,
          title: pr.title,
          author: pr.authorLogin,
          projects: [],
          additions: pr.additions,
          deletions: pr.deletions,
          openedAt: pr.openedAt.toISOString(),
          waitingHours,
          neverReviewed: true,
        });
      }
    }

    // Ordered by how long the CHANGE has waited — a property of the pull
    // request, not a ranking of the people who opened them.
    waiting.sort((a, b) => b.waitingHours - a.waitingHours);

    const raised = new Map<string, number>();
    for (const pr of windowPrs) {
      if (!pr.authorLogin) {
        continue;
      }
      const person = index.byLogin.get(pr.authorLogin) ?? pr.authorLogin;
      raised.set(person, (raised.get(person) ?? 0) + 1);
    }

    const reviewed = new Map<string, number>();
    let botReviews = 0;
    for (const review of reviews) {
      if (review.isBot) {
        // A bot approving in seconds flatters both coverage and latency while
        // no human has looked at the change (METRICS.md §0).
        botReviews += 1;
        continue;
      }
      if (!review.reviewerLogin) {
        continue;
      }
      const person =
        index.byLogin.get(review.reviewerLogin) ?? review.reviewerLogin;
      reviewed.set(person, (reviewed.get(person) ?? 0) + 1);
    }

    const people = new Set([
      ...raised.keys(),
      ...reviewed.keys(),
      ...oldestWaitByDeveloper.keys(),
    ]);
    const reviewLoad: ReviewLoadRow[] = [...people]
      .map((developer) => ({
        developer,
        displayName: index.displayNames.get(developer) ?? developer,
        prsRaised: raised.get(developer) ?? 0,
        prsReviewed: reviewed.get(developer) ?? 0,
        oldestWaitingHours: oldestWaitByDeveloper.get(developer) ?? null,
      }))
      // A–Z: review is a service to the team, and ordering people by how much
      // of it they did is a leaderboard whichever end you read it from.
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return {
      totals: {
        open: openPrs.length,
        waitingOverThreshold,
        neverReviewed,
        reviewsGiven: reviews.length - botReviews,
        botReviews,
      },
      waiting: waiting.slice(0, 50),
      reviewLoad,
      excludedNoReviewData,
      thresholdHours: REVIEW_WAIT_ALERT_HOURS,
      windowDays,
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * The person-page facts `InsightsService.developerActivity` doesn't carry:
   * reviews they gave, and the Jira work assigned to them.
   *
   * Additive and separately fetched so the existing profile read is untouched.
   * `assignment: null` means the bridge never matched this person — the page
   * must say so rather than render an empty list as "nothing assigned"
   * (DASHBOARDS.md §4.4.3).
   */
  async developerContext(
    developer: string,
    from: Date,
    to: Date,
  ): Promise<DeveloperContextView> {
    const tenantId = this.tenantContext.requireTenantId();
    const [aliases, assignees] = await Promise.all([
      this.identities.aliasesFor(tenantId, developer),
      this.identities.jiraAssigneeIndex(tenantId),
    ]);

    const refs = assignees.byDeveloper.get(developer);
    const [reviewsGiven, assignedItems] = await Promise.all([
      this.prisma.prReview.count({
        where: {
          tenantId,
          isBot: false,
          reviewerLogin: { in: aliases.logins },
          submittedAt: { gte: from, lte: to },
        },
      }),
      refs
        ? this.prisma.story.findMany({
            where: {
              tenantId,
              NOT: { statusCategory: 'done' },
              OR: [
                ...(refs.logins.length > 0
                  ? [{ assigneeLogin: { in: refs.logins } }]
                  : []),
                ...(refs.names.length > 0
                  ? [{ assigneeName: { in: refs.names } }]
                  : []),
              ],
            },
            select: {
              externalKey: true,
              projectKey: true,
              type: true,
              status: true,
              title: true,
              sprintExternalId: true,
            },
            orderBy: { externalKey: 'asc' },
            take: 50,
          })
        : Promise.resolve([]),
    ]);

    return {
      prsReviewed: reviewsGiven,
      assignment: refs
        ? {
            openItems: assignedItems.map((item) => ({
              key: item.externalKey,
              projectKey: item.projectKey,
              type: item.type,
              status: item.status,
              title: item.title,
              inSprint: Boolean(item.sprintExternalId),
            })),
            jiraRefs: [...refs.logins, ...refs.names],
          }
        : null,
      assigneeCoverage: this.identities.bridgeCoverage([developer], assignees),
    };
  }

  /**
   * Newest signal of any kind per developer, looked back far enough to answer
   * the widest bucket.
   *
   * Bounded by `QUIET_WITHIN_WORKING_DAYS` rather than unbounded: someone whose
   * last commit was two years ago and someone who has never committed are the
   * same answer to this page ("no signal in 30 working days"), and scanning
   * all history to distinguish them costs a full-table read per load.
   *
   * Bounded above by `asOf` as well, so a range ending in the past is judged by
   * what was known then (`signalScanRange`).
   */
  private async lastSignalPerDeveloper(
    tenantId: string,
    index: { byLogin: Map<string, string>; byEmail: Map<string, string> },
    asOf: Date,
  ): Promise<Map<string, { type: SignalType; at: Date }>> {
    const scan = signalScanRange(asOf);
    const [commits, prsOpened, prsMerged, reviews] = await Promise.all([
      this.prisma.commit.groupBy({
        by: ['authorLogin', 'authorEmail'],
        where: { tenantId, committedAt: scan },
        _max: { committedAt: true },
      }),
      this.prisma.pullRequest.groupBy({
        by: ['authorLogin'],
        where: {
          tenantId,
          authorLogin: { not: null },
          openedAt: scan,
        },
        _max: { openedAt: true },
      }),
      this.prisma.pullRequest.groupBy({
        by: ['authorLogin'],
        where: {
          tenantId,
          authorLogin: { not: null },
          mergedAt: scan,
        },
        _max: { mergedAt: true },
      }),
      this.prisma.prReview.groupBy({
        by: ['reviewerLogin'],
        where: {
          tenantId,
          isBot: false,
          reviewerLogin: { not: null },
          submittedAt: scan,
        },
        _max: { submittedAt: true },
      }),
    ]);

    const out = new Map<string, { type: SignalType; at: Date }>();
    const record = (
      person: string | undefined,
      type: SignalType,
      at: Date | null,
    ) => {
      if (!person || !at) {
        return;
      }
      const existing = out.get(person);
      if (!existing || at > existing.at) {
        out.set(person, { type, at });
      }
    };

    for (const row of commits) {
      record(
        attributeCommit(
          { authorLogin: row.authorLogin, authorEmail: row.authorEmail },
          index,
        ),
        'commit',
        row._max.committedAt,
      );
    }
    for (const row of prsOpened) {
      record(
        row.authorLogin
          ? (index.byLogin.get(row.authorLogin) ?? row.authorLogin)
          : undefined,
        'pr_opened',
        row._max.openedAt,
      );
    }
    for (const row of prsMerged) {
      record(
        row.authorLogin
          ? (index.byLogin.get(row.authorLogin) ?? row.authorLogin)
          : undefined,
        'pr_merged',
        row._max.mergedAt,
      );
    }
    for (const row of reviews) {
      record(
        row.reviewerLogin
          ? (index.byLogin.get(row.reviewerLogin) ?? row.reviewerLogin)
          : undefined,
        'pr_reviewed',
        row._max.submittedAt,
      );
    }
    return out;
  }

  /**
   * Open Jira items per canonical developer, via the assignee bridge.
   *
   * "Open" is `statusCategory != done` rather than a status-name list: status
   * names are per-project and unbounded, which is the reason `statusCategory`
   * exists at all (schema, `planning_story`). Items collected before that field
   * was requested carry null and are counted as open — the conservative
   * direction here, since over-counting assigned work can only ever REMOVE
   * someone from the "no assigned work" list, never add them to it wrongly.
   */
  private async openAssignedByDeveloper(
    tenantId: string,
    byDeveloper: Map<string, { logins: string[]; names: string[] }>,
  ): Promise<Map<string, number>> {
    if (byDeveloper.size === 0) {
      return new Map();
    }
    const rows = await this.prisma.story.groupBy({
      by: ['assigneeLogin', 'assigneeName'],
      where: {
        tenantId,
        NOT: { statusCategory: 'done' },
        OR: [{ assigneeLogin: { not: null } }, { assigneeName: { not: null } }],
      },
      _count: { _all: true },
    });

    const developerByLogin = new Map<string, string>();
    const developerByName = new Map<string, string>();
    for (const [developer, refs] of byDeveloper) {
      for (const login of refs.logins) {
        developerByLogin.set(login, developer);
      }
      for (const name of refs.names) {
        developerByName.set(name, developer);
      }
    }

    const out = new Map<string, number>();
    for (const row of rows) {
      const developer =
        (row.assigneeLogin
          ? developerByLogin.get(row.assigneeLogin)
          : undefined) ??
        (row.assigneeName ? developerByName.get(row.assigneeName) : undefined);
      if (!developer) {
        continue;
      }
      out.set(developer, (out.get(developer) ?? 0) + row._count._all);
    }
    return out;
  }

  /** Canonical developers who committed inside the window. */
  private async committersBetween(
    tenantId: string,
    index: { byLogin: Map<string, string>; byEmail: Map<string, string> },
    from: Date,
    to: Date,
  ): Promise<Set<string>> {
    const rows = await this.prisma.commit.groupBy({
      by: ['authorLogin', 'authorEmail'],
      where: { tenantId, committedAt: { gte: from, lte: to } },
    });
    const out = new Set<string>();
    for (const row of rows) {
      const person = attributeCommit(row, index);
      if (person) {
        out.add(person);
      }
    }
    return out;
  }
}

/**
 * The planning gap: committed in the window, matched to a Jira account, and
 * carrying no open item.
 *
 * **One definition, called from both places that report this number.** It was
 * briefly two, and they disagreed on real data (Overview said 3, Watchlist said
 * 0) because Overview filtered on *bridge membership* — counting the people the
 * assignee bridge FAILED to match as people with nothing assigned. That is the
 * precise inversion DASHBOARDS.md §4.4.5 exists to forbid: it reports a data gap
 * as a finding about a person, and on a tenant with 41% assignee coverage it
 * would accuse most of the roster of working off-plan.
 *
 * Both conditions are load-bearing:
 *  - `matched` — an unmatched developer's tickets are invisible to us, so we
 *    cannot say anything about them. They are excluded, not counted.
 *  - `openAssigned === 0` — the actual finding.
 */
export function planningGapDevelopers(
  committers: Iterable<string>,
  matched: ReadonlySet<string>,
  openAssigned: ReadonlyMap<string, number>,
): string[] {
  return [...committers].filter(
    (person) => matched.has(person) && (openAssigned.get(person) ?? 0) === 0,
  );
}

/**
 * Whose commit this is. A login is an identity even before the resolution pass
 * has seen it; only a commit with neither a known login nor a known email is
 * genuinely unattributable.
 */
function attributeCommit(
  commit: { authorLogin: string | null; authorEmail: string | null },
  index: { byLogin: Map<string, string>; byEmail: Map<string, string> },
): string | undefined {
  if (commit.authorLogin) {
    return index.byLogin.get(commit.authorLogin) ?? commit.authorLogin;
  }
  if (commit.authorEmail) {
    return index.byEmail.get(commit.authorEmail.toLowerCase());
  }
  return undefined;
}

function hoursBetween(from: Date, to: Date): number {
  return Number(((to.getTime() - from.getTime()) / 3_600_000).toFixed(1));
}

/**
 * The instant `workingDays` Mon–Fri days ago.
 *
 * Working days rather than calendar days because the alternative marks the
 * whole roster quiet every Monday morning: a threshold of "7 days" spends two
 * of them on a weekend nobody was expected to commit through. Public holidays
 * are NOT modelled — SprintIQ has no holiday calendar, and inventing one per
 * tenant would be a guess dressed as a fact. A team returning from a long
 * holiday therefore reads slightly quieter than it was, which the board's
 * framing ("go ask", not "conclude") is built to tolerate.
 */
export function workingDaysAgo(now: Date, workingDays: number): Date {
  const cursor = new Date(now);
  let remaining = workingDays;
  while (remaining > 0) {
    cursor.setDate(cursor.getDate() - 1);
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) {
      remaining -= 1;
    }
  }
  return cursor;
}

/** Which attention bucket a last-signal timestamp falls in. */
/**
 * The window scanned for "newest signal per developer", as of a moment.
 *
 * Both bounds matter. The lower one keeps the scan cheap — someone whose last
 * commit was two years ago and someone who never committed are the same answer
 * to this page. The upper one is what makes a historical range truthful: a
 * signal from AFTER the range must not decide a bucket inside it, or a
 * developer who returned in August reads as active on an April–June board.
 *
 * Written as one helper rather than inline in each of the four `groupBy` calls
 * so the upper bound cannot be forgotten from one of them.
 */
export function signalScanRange(asOf: Date): { gte: Date; lte: Date } {
  return {
    gte: workingDaysAgo(asOf, WATCHLIST_QUIET_WITHIN_WORKING_DAYS),
    lte: asOf,
  };
}

export function bucketFor(lastSignal: Date | null, now: Date): WatchlistBucket {
  if (!lastSignal) {
    return 'no_signal';
  }
  if (lastSignal >= workingDaysAgo(now, WATCHLIST_ACTIVE_WITHIN_WORKING_DAYS)) {
    return 'active';
  }
  if (lastSignal >= workingDaysAgo(now, WATCHLIST_QUIET_WITHIN_WORKING_DAYS)) {
    return 'quiet';
  }
  return 'no_signal';
}
