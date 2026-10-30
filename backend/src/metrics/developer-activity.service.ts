import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import {
  istDateKey,
  istMonthEnd,
  istMonthStart,
  lastIstMonths,
} from '../common/time';
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
import {
  CodeService,
  CopilotCoverage,
  CopilotUsageRow,
} from '../modules/code/code.service';
import { distinctCommitsBySha } from './commit-dedupe';
import { isMergeCommit } from './merge-commits';

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

/**
 * What kind of work a developer does, as stated by an admin (DASHBOARDS.md
 * §4.4.8). A closed set, written as a const union rather than a Prisma enum:
 * this schema has none, and a fourth role stays a code change instead of a
 * migration.
 *
 * SprintIQ cannot observe this. A QA engineer committing test automation and a
 * backend developer are indistinguishable in the delivery graph, and inferring
 * the difference from paths or commit messages would be a guess presented as a
 * fact — so nothing in this file ever derives one.
 */
export const DEVELOPER_ROLES = ['DEV', 'QA', 'OTH'] as const;

export type DeveloperRoleValue = (typeof DEVELOPER_ROLES)[number];

/**
 * Whether an arbitrary value is one of the three roles.
 *
 * Exact match, deliberately: `'dev'` is the likeliest client mistake, and
 * accepting it would store a value the UI matches on exactly — rendering as an
 * unknown badge no reader can interpret and no admin can clear.
 */
export function isDeveloperRole(value: unknown): value is DeveloperRoleValue {
  return (
    typeof value === 'string' &&
    (DEVELOPER_ROLES as readonly string[]).includes(value)
  );
}

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
   * The admin-stated DEV/QA/OTH classification, or `null` when nobody has made
   * one — never `OTH`, which is a person deciding "none of these".
   */
  role: DeveloperRoleValue | null;
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

/** One person's tracked signals in the window. Context, never a score. */
export interface ActiveDeveloper {
  /** Canonical developer id — what `?developer=` resolves against. */
  developer: string;
  displayName: string;
  commits: number;
  /** Lines added across their attributed commits in the window. */
  additions: number;
  deletions: number;
  /**
   * `additions + deletions` — volume, never a productivity score, and never
   * an ordering (CLAUDE.md). The same definition every other board reports.
   */
  locChanged: number;
  prsOpened: number;
  prsMerged: number;
  /**
   * Merge commits they made in the window — NOT in `commits` or the LOC
   * fields (METRICS.md §0), disclosed so a merge-only contributor's row of
   * zeros reads as "merged, wrote nothing new" rather than as absent data.
   */
  mergeCommits: number;
  /**
   * The admin-stated DEV/QA/OTH classification, or `null` when nobody has made
   * one. `null` is NOT `OTH`: `OTH` is a person deciding "none of these", and
   * null is nobody having decided at all. Never collapse them.
   */
  role: DeveloperRoleValue | null;
  /**
   * Copilot usage in the window (ADR-0012), or `null` when the tenant has
   * never collected a Copilot report — then the column isn't shown at all.
   * Context beside the person, never an ordering and never part of any grade.
   */
  copilot: DeveloperCopilot | null;
}

/**
 * One person's Copilot usage over the window, from GitHub's usage-metrics
 * reports (ADR-0012).
 *
 * - `active` — at least one day GitHub reported Copilot activity for them.
 * - `seat_unused` — holds a seat, no activity reported in the window.
 * - `no_seat` — no seat in the latest snapshot and no activity reported.
 * - `no_activity` — no activity reported, and seats aren't known.
 *
 * None of these means "didn't use AI": GitHub doesn't count Copilot on
 * github.com or mobile, or an IDE with telemetry off.
 */
export interface DeveloperCopilot {
  status: 'active' | 'seat_unused' | 'no_seat' | 'no_activity';
  /** Distinct UTC report days with any reported activity. */
  activeDays: number;
  /** `loc_added_sum` over the window — lines Copilot added. Volume, never a score. */
  linesAdded: number;
}

/** The Copilot inputs the roster needs, already keyed by canonical developer. */
export interface CopilotLookup {
  usage: ReadonlyMap<string, { activeDays: number; linesAdded: number }>;
  /** Developers holding a seat; `null` when no seat snapshot was ever taken. */
  seatHolders: ReadonlySet<string> | null;
}

export interface OverviewView {
  totals: {
    /** Authored commits — merge commits excluded (METRICS.md §0). */
    commits: number;
    /** Merge commits in the window, left out of `commits` and every LOC figure. */
    mergeCommitsExcluded: number;
    /**
     * Extra copies of commits held by more than one repository (copied
     * repos), counted once here (METRICS.md §0).
     */
    sharedCommitsCollapsed: number;
    /**
     * Tracked developers (the Tracked Developers list) with a signal in the
     * window — the board's headline "active developers" (2026-10-27). When no
     * one is tracked yet, every person with a signal, as before.
     */
    developersWithSignal: number;
    /**
     * Active entries on the Tracked Developers list — the denominator of the
     * headline (2026-10-27). `null` when the list is empty: then the board
     * falls back to everyone with a signal and has no denominator.
     */
    trackedDevelopers: number | null;
    /**
     * Every developer identity ever seen, bots, excluded and unmatched ones
     * included. Kept for older clients; no longer shown — it was never a
     * meaningful denominator.
     */
    developersKnown: number;
    prsOpened: number;
    prsMerged: number;
    /** Committing with nothing assigned; null when the bridge matched nobody. */
    committingWithoutAssignedWork: number | null;
  };
  /**
   * Everyone with a signal in the window, alphabetical. Exactly the set
   * `totals.developersWithSignal` counts, so the list and the tile can never
   * disagree about the same window.
   */
  activeDevelopers: ActiveDeveloper[];
  /**
   * Freshness for the roster's Copilot column. `collected: false` means no
   * report has ever been collected for this tenant (the column is hidden).
   * GitHub publishes a day's report ~2 days after it closes, so
   * `coveredThrough` normally trails the window's end.
   */
  copilot: CopilotCoverage;
  /**
   * Commits and changed LOC per IST day, with that day's contributors for the
   * drill-down. See `commitDays`.
   */
  days: ActivityDay[];
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
  /** The GitHub login, as collected. */
  author: string | null;
  /**
   * The canonical developer id the login resolves to — what the Developer
   * page is addressed by. A raw login of someone an admin merged into another
   * identity opens a partial profile, so links use this, never `author`.
   */
  authorDeveloper: string | null;
  /** What every other people table on these pages calls this person. */
  authorDisplayName: string | null;
  projects: string[];
  additions: number;
  deletions: number;
  openedAt: string;
  waitingHours: number;
  /** No human review yet — distinct from "reviewed, still open". */
  neverReviewed: boolean;
}

export interface ReviewLoadRow {
  developer: string;
  displayName: string;
  prsRaised: number;
  /** Reviews submitted, not distinct PRs; self-reviews and bots excluded. */
  prsReviewed: number;
  /** Hours their oldest unreviewed PR has waited. A fact, not an average. */
  oldestWaitingHours: number | null;
}

export interface PrStatusView {
  /**
   * The queue figures (`open`, `waitingOverThreshold`, `neverReviewed`,
   * `botReviewedOnly`, `botAuthored`) cover PRs OPENED IN THE RANGE that are
   * still open now, waits measured to now. `reviewsGiven` and its exclusions
   * count reviews submitted in the range.
   */
  totals: {
    /** Open PRs by people — automation-authored ones are in `botAuthored`. */
    open: number;
    waitingOverThreshold: number;
    neverReviewed: number;
    /**
     * Of `neverReviewed`, PRs a bot DID review. GitHub shows them as reviewed;
     * this page does not, because no person has looked at the change yet.
     */
    botReviewedOnly: number;
    reviewsGiven: number;
    /** Automated reviews, excluded from `reviewsGiven` and every row below. */
    botReviews: number;
    /** An author reviewing their own PR — not a review given to the team. */
    selfReviews: number;
    /** Open PRs raised by automation (Dependabot, Renovate…), not counted above. */
    botAuthored: number;
  };
  /**
   * The same three queue figures over tracked developers' PRs only — the
   * subset the tables list. `null` while nobody is tracked, when the tables
   * and the tiles already cover the same PRs.
   */
  tracked: {
    open: number;
    waitingOverThreshold: number;
    neverReviewed: number;
  } | null;
  /** Oldest first, at most `WAITING_ROWS`; `waitingTotal` is the uncut count. */
  waiting: WaitingPr[];
  waitingTotal: number;
  reviewLoad: ReviewLoadRow[];
  /**
   * Open PRs whose review timeline was never fetched. They cannot be called
   * unreviewed — that would indict collection lag as a review failure.
   */
  excludedNoReviewData: number;
  /** Open PRs with no opened date: no range can place them, no wait to measure. */
  excludedNoOpenedDate: number;
  /**
   * Open PRs by people that were opened before or after the range. The queue
   * covers PRs opened in the range; these are what a wider range brings in,
   * and the page states the number so an old unreviewed change never vanishes
   * without a trace.
   */
  openOutsideRange: number;
  /**
   * When the stalest review timeline among the open PRs was fetched.
   *
   * Open PRs are not re-asked for reviews once collected (api/README.md §12),
   * so a review submitted after this instant may not be reflected yet. The
   * page states it rather than presenting the queue as live.
   */
  reviewsFetchedOldestAt: string | null;
  thresholdHours: number;
  windowDays: number;
  computedAt: string;
}

/** Rows on the PR Status waiting table; the rest are counted, not listed. */
export const WAITING_ROWS = 50;

/** Months on the Overview trend. A year, fixed — not the section's window. */
export const TREND_MONTHS = 12;

export interface TrendMonth {
  /** IST calendar month, `YYYY-MM`. */
  month: string;
  commits: number;
  additions: number;
  deletions: number;
  /** Additions + deletions — the same "changed LOC" every other board reports. */
  locChanged: number;
  /** Merge commits in the month, left out of `commits` and the LOC fields. */
  mergeCommitsExcluded: number;
  /** Extra copies of commits held by more than one repository, counted once. */
  sharedCommitsCollapsed: number;
  /**
   * Whether collection had reached this month at all.
   *
   * `false` means the figures beside it are not a measurement, and the chart
   * must break its line rather than plot them: a month the backfill never
   * walked yields zero, and drawing that zero asserts nobody committed.
   */
  collected: boolean;
}

export interface MonthlyTrendView {
  /** Oldest month first — the order the chart plots. */
  months: TrendMonth[];
  /**
   * How deep collection reaches, from the connection watermarks. `null` means
   * no floor is known (some active connection has walked nowhere), which is
   * why every month can still be marked collected while the number itself
   * says the depth is unverified.
   */
  collectedBackTo: string | null;
  computedAt: string;
}

/**
 * Whether a trend month rests on collected data.
 *
 * A month counts only if collection reached its FIRST instant. The month a
 * backfill stopped inside is part-walked, and a part-walked month rendered as
 * a whole one is a dip that never happened.
 *
 * An unknown floor (`null`) is treated as collected: it means "we do not know
 * how deep history goes", not "there is no history", and dimming all twelve
 * months would overstate our ignorance as confidently as a zero overstates our
 * knowledge. The null rides along in the payload so the caption can say so.
 */
export function monthCollected(
  month: string,
  collectedBackTo: Date | null,
): boolean {
  if (!collectedBackTo) return true;
  return istMonthStart(month).getTime() >= collectedBackTo.getTime();
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
    // Copilot reports are per UTC day; the window is IST days. A report day is
    // in the window when its date is — a day's edge hours can land one side or
    // the other, which the column's caption says.
    const fromDay = istDateKey(from);
    const toDay = istDateKey(to);
    const [
      page,
      index,
      attribution,
      assignees,
      prs,
      roles,
      copilotRows,
      copilotSeats,
      copilotCoverage,
      trackedScope,
    ] = await Promise.all([
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
      this.rolesByDeveloper(tenantId),
      this.code.copilotUsageRows(tenantId, fromDay, toDay),
      this.code.copilotSeatLogins(tenantId),
      this.code.copilotCoverage(tenantId, fromDay, toDay),
      this.trackedDevelopers(tenantId),
    ]);
    const { truncated } = page;
    // A commit held by several repositories (a repo created from another's
    // history) counts once on this team- and person-level board (METRICS.md §0).
    const { commits, sharedCommitsCollapsed } = distinctCommitsBySha(
      page.commits,
    );

    const committers = new Set<string>();
    // Window totals per person, accumulated from the same passes the day
    // buckets already make — the roster costs no extra query.
    const commitsByDeveloper = new Map<string, number>();
    // Accumulated in the same pass as the commit counts, from rows already in
    // memory — the roster's LOC column costs no query, exactly as its commit
    // and PR columns don't.
    const locByDeveloper = new Map<
      string,
      { additions: number; deletions: number }
    >();
    const prsByDeveloper = new Map<
      string,
      { opened: number; merged: number }
    >();

    // Merge commits count toward the signal sets (`committers`, and
    // `activeDeveloperSet` below, shared with the digest) but not toward any
    // commit count or LOC figure (METRICS.md §0, `merge-commits.ts`).
    const mergesByDeveloper = new Map<string, number>();
    let mergeCommitsExcluded = 0;
    for (const c of commits) {
      const person = attributeCommit(c, index);
      if (isMergeCommit(c)) {
        mergeCommitsExcluded += 1;
        if (person) {
          mergesByDeveloper.set(
            person,
            (mergesByDeveloper.get(person) ?? 0) + 1,
          );
          committers.add(person);
        }
        continue;
      }
      if (person) {
        commitsByDeveloper.set(
          person,
          (commitsByDeveloper.get(person) ?? 0) + 1,
        );
        const loc = locByDeveloper.get(person) ?? {
          additions: 0,
          deletions: 0,
        };
        loc.additions += c.additions;
        loc.deletions += c.deletions;
        locByDeveloper.set(person, loc);
        committers.add(person);
      }
    }

    let prsMerged = 0;
    for (const pr of prs) {
      if (pr.mergedAt) {
        prsMerged += 1;
      }
      if (pr.authorLogin) {
        const person = index.byLogin.get(pr.authorLogin) ?? pr.authorLogin;
        const acc = prsByDeveloper.get(person) ?? { opened: 0, merged: 0 };
        acc.opened += 1;
        if (pr.mergedAt) {
          acc.merged += 1;
        }
        prsByDeveloper.set(person, acc);
      }
    }

    // One definition, shared with the daily digest — see `activeDeveloperSet`.
    const withSignal = activeDeveloperSet(commits, prs, index);

    // People only, for the tile and the roster alike — bots, anonymized
    // accounts and admin exclusions are not developers (DASHBOARDS.md §4.4.7),
    // and applying the filter to one and not the other would make the list
    // and the number above it disagree. `activeDeveloperSet` itself is left
    // whole: the digest shares it and applies its own suppressions.
    const isPerson = (developer: string) =>
      !isBotDeveloper(developer) &&
      !isAnonymizedAccount(developer) &&
      !index.excluded.has(developer);

    // Every per-person figure on the board — the headline, the roster, the
    // day drill-down, the planning-gap count — covers the Tracked Developers
    // list only (product decision 2026-10-27): untracked people are never
    // named or counted here, though their work stays in every team total.
    // With no list configured yet, everyone counts, as before.
    const tracked = trackedScope;
    const inScope = (developer: string) => !tracked || tracked.has(developer);
    const counted = (developer: string) =>
      isPerson(developer) && inScope(developer);

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
    const coverage = this.identities.bridgeCoverage(
      committers,
      assignees,
      index.excluded,
    );
    const withoutAssignedWork =
      assignees.assignees.matched === 0
        ? null
        : planningGapDevelopers(
            committers,
            new Set(assignees.byDeveloper.keys()),
            openAssigned,
          ).filter(inScope).length;

    return {
      totals: {
        commits: commits.length - mergeCommitsExcluded,
        mergeCommitsExcluded,
        sharedCommitsCollapsed,
        developersWithSignal: [...withSignal].filter(counted).length,
        trackedDevelopers: tracked ? tracked.size : null,
        developersKnown: index.displayNames.size,
        prsOpened: prs.length,
        prsMerged,
        committingWithoutAssignedWork: withoutAssignedWork,
      },
      activeDevelopers: activeDeveloperRoster(
        commitsByDeveloper,
        locByDeveloper,
        prsByDeveloper,
        index.displayNames,
        roles,
        mergesByDeveloper,
        copilotCoverage.collected
          ? copilotLookup(copilotRows, copilotSeats, index.byLogin)
          : null,
      ).filter((row) => counted(row.developer)),
      copilot: copilotCoverage,
      // Day totals (commits, LOC) keep all work; the contributors named under
      // each day are tracked developers only.
      days: commitDays(commits, index).map((day) => ({
        ...day,
        developers: day.developers.filter((d) => inScope(d.developer)),
      })),
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
   * Commit and changed-LOC volume per IST calendar month, over the last year.
   *
   * A fixed 12-month window on purpose: it is a trend, and a trend that
   * resizes with the section's range selector cannot be compared to itself
   * between two visits. The controller passes no range for the same reason.
   *
   * **Aggregated in the database, never listed.** `listCommitsPage` caps its
   * read and reports `truncated` because its rows get summed; a year-long
   * version of that read would hit the cap on any busy tenant and quietly
   * under-report the oldest months — the exact failure that cap exists to
   * disclose. Twelve `aggregate` calls count and sum in Postgres instead: no
   * rows cross the wire, no ceiling, nothing to truncate.
   *
   * Figures on a month with `collected: false` are a floor, not a measurement
   * — whatever happens to have been walked so far. The flag, not the number,
   * is what a consumer must read.
   */
  async monthlyTrend(
    repos: string[],
    collectedBackTo: Date | null,
    now: Date = new Date(),
  ): Promise<MonthlyTrendView> {
    const tenantId = this.tenantContext.requireTenantId();
    const months = lastIstMonths(TREND_MONTHS, now);

    // One grouped read over the year (was 24 aggregates): a commit held by
    // several repositories counts once (METRICS.md §0), which a per-row
    // aggregate cannot express. Merge commits are out of the count and the
    // sums and reported beside them. Months by IST, on committer date —
    // matching `listCommitsPage`, so the trend and the day series agree.
    const from = istMonthStart(months[0]);
    const to = istMonthEnd(months[months.length - 1]);
    const repoFilter =
      repos.length > 0
        ? Prisma.sql`AND "repoFullName" IN (${Prisma.join(repos)})`
        : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      {
        month: string;
        commits: number;
        additions: number;
        deletions: number;
        merges: number;
        copies: number;
      }[]
    >`
      WITH c AS (
        SELECT sha, "repoFullName", additions, deletions,
               COALESCE("parentCount", 0) > 1 AS is_merge,
               to_char("committedAt" + interval '5 hours 30 minutes', 'YYYY-MM') AS month
        FROM code_commit
        WHERE "tenantId" = ${tenantId}
          AND "committedAt" >= ${from} AND "committedAt" <= ${to}
          ${repoFilter}
      ),
      d AS (SELECT DISTINCT ON (sha) * FROM c ORDER BY sha, "repoFullName")
      SELECT d.month,
             COUNT(*) FILTER (WHERE NOT d.is_merge)::int AS commits,
             COALESCE(SUM(d.additions) FILTER (WHERE NOT d.is_merge), 0)::int AS additions,
             COALESCE(SUM(d.deletions) FILTER (WHERE NOT d.is_merge), 0)::int AS deletions,
             COUNT(*) FILTER (WHERE d.is_merge)::int AS merges,
             (SELECT COUNT(*) FROM c WHERE c.month = d.month)::int - COUNT(*)::int AS copies
      FROM d GROUP BY d.month
    `;
    const byMonth = new Map(rows.map((r) => [r.month, r]));

    return {
      months: months.map((month) => {
        const r = byMonth.get(month);
        const additions = r?.additions ?? 0;
        const deletions = r?.deletions ?? 0;
        return {
          month,
          commits: r?.commits ?? 0,
          additions,
          deletions,
          locChanged: additions + deletions,
          mergeCommitsExcluded: r?.merges ?? 0,
          sharedCommitsCollapsed: r?.copies ?? 0,
          collected: monthCollected(month, collectedBackTo),
        };
      }),
      collectedBackTo: collectedBackTo?.toISOString() ?? null,
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
  /**
   * Who Engineering Activity may show per-person data about: the active
   * entries of the admin-editable Tracked Developers list, read live so an
   * edit takes effect on the next load (product decision 2026-10-27).
   * Untracked people stay in the database and in every team total; they are
   * only never named, listed or profiled on these pages. `null` when the list
   * is empty — then nothing is scoped, as before the decision.
   */
  async trackedDevelopers(tenantId: string): Promise<Set<string> | null> {
    const rows = await this.prisma.trackedDeveloper.findMany({
      where: { tenantId, active: true },
      select: { canonicalDeveloperId: true },
    });
    return rows.length > 0
      ? new Set(rows.map((r) => r.canonicalDeveloperId))
      : null;
  }

  /**
   * Whether the Developer page may show this person: always when nothing is
   * tracked, else only a tracked developer — the id the page links with, or
   * a login of theirs.
   */
  async isDisplayable(developer: string): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();
    const scope = await this.trackedDevelopers(tenantId);
    if (!scope) return true;
    if (scope.has(developer)) return true;
    const index = await this.identities.attributionIndex(tenantId);
    const canonical = index.byLogin.get(developer);
    return canonical !== undefined && scope.has(canonical);
  }

  async watchlist(
    from: Date,
    to: Date,
    windowDays: number,
  ): Promise<WatchlistView> {
    const tenantId = this.tenantContext.requireTenantId();
    const [index, assignees, exclusionRows, roles, scope] = await Promise.all([
      this.identities.attributionIndex(tenantId),
      this.identities.jiraAssigneeIndex(tenantId),
      this.prisma.watchlistExclusion.findMany({
        // Live exclusions only — a lapsed one is not a statement about today.
        where: { tenantId, expiresAt: { gt: new Date() } },
      }),
      this.rolesByDeveloper(tenantId),
      this.trackedDevelopers(tenantId),
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
      // Tracked developers only, once a list exists (2026-10-27): every list
      // on this page — buckets, planning gap, unlinked, inactive — is built
      // from this loop, so this one check scopes them all.
      if (scope && !scope.has(developer)) {
        continue;
      }
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
      // The same judgement, made by a person instead of a heuristic: an entity
      // an admin has ruled is not a developer. Unlike the Watchlist exclusion
      // above it carries no expiry, because it is not a statement about
      // someone being temporarily away — it is a statement that there is
      // nobody there.
      if (index.excluded.has(developer)) {
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
        // Absent from the map means nobody has classified them — `null`, not
        // `OTH`, for the same reason `hasAssignedWork` below stays null.
        role: roles.get(developer) ?? null,
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
        .filter((row) => !scope || scope.has(row.canonicalDeveloperId))
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
        index.excluded,
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

    const [openPrs, windowPrs, windowReviews, index, scope] = await Promise.all(
      [
        // Every open PR, not just the range's: the ones opened outside it are
        // still counted (`openOutsideRange`), because an old unreviewed change
        // is the most actionable thing here and must never vanish silently.
        // Uncapped: this read used to stop at the 500 oldest, so "Open PRs"
        // silently topped out and every count beneath it covered only part of
        // the queue.
        this.prisma.pullRequest.findMany({
          where: { tenantId, ...repoFilter, state: 'open' },
          select: {
            repoFullName: true,
            externalNumber: true,
            title: true,
            authorLogin: true,
            additions: true,
            deletions: true,
            openedAt: true,
            reviewsFetchedAt: true,
          },
          orderBy: { openedAt: 'asc' },
        }),
        this.prisma.pullRequest.findMany({
          where: { tenantId, ...repoFilter, openedAt: { gte: from, lte: to } },
          select: { authorLogin: true },
        }),
        this.prisma.prReview.findMany({
          where: {
            tenantId,
            ...repoFilter,
            submittedAt: { gte: from, lte: to },
          },
          select: {
            repoFullName: true,
            externalNumber: true,
            reviewerLogin: true,
            isBot: true,
          },
        }),
        this.identities.attributionIndex(tenantId),
        this.trackedDevelopers(tenantId),
      ],
    );

    const prKey = (r: { repoFullName: string; externalNumber: string }) =>
      `${r.repoFullName}#${r.externalNumber}`;
    const personOf = (login: string) => index.byLogin.get(login) ?? login;
    // Automation is not a colleague whose change is waiting on the team, and
    // an entity an admin has ruled is not a person is the same judgement made
    // by hand (DASHBOARDS.md §4.4.4). Checked on the raw login as well as the
    // canonical id: GraphQL collects Dependabot as a bare `dependabot`, which
    // only the known-login list catches, and an unresolved login IS its id.
    const isAutomation = (login: string) =>
      isBotDeveloper(login) ||
      isBotDeveloper(personOf(login)) ||
      index.excluded.has(personOf(login));
    // Totals count every PR; rows name tracked developers only, once a list
    // exists (2026-10-27). A PR with no known author names nobody tracked.
    const shown = (person: string | null) =>
      !scope || (person !== null && scope.has(person));

    // The queue is the open PRs OPENED IN THE RANGE (product decision
    // 2026-10-30, replacing "open PRs are not windowed"): of the changes raised
    // in the window, which are still waiting today. The rest are counted, not
    // hidden — `openOutsideRange` is what a wider range would bring in, and
    // `excludedNoOpenedDate` what no range can place. Automation is left out
    // of both, as it is out of the queue.
    let openOutsideRange = 0;
    let excludedNoOpenedDate = 0;
    const queuePrs: ((typeof openPrs)[number] & { openedAt: Date })[] = [];
    for (const pr of openPrs) {
      const automated = !!pr.authorLogin && isAutomation(pr.authorLogin);
      if (!pr.openedAt) {
        // No opened date: neither placeable in a range nor a wait to measure.
        // Not dated from `createdAt`, which is when WE inserted the row.
        if (!automated) excludedNoOpenedDate += 1;
        continue;
      }
      if (pr.openedAt < from || pr.openedAt > to) {
        if (!automated) openOutsideRange += 1;
        continue;
      }
      queuePrs.push({ ...pr, openedAt: pr.openedAt });
    }

    // Reviews on the queue's PRs, of any date, and the authors of the PRs
    // reviewed in the window — both needed to tell a review by a PERSON OTHER
    // THAN THE AUTHOR from the rest. Fetched as repo × number supersets and
    // narrowed by key below: one query each rather than one per PR.
    const [openReviews, reviewedPrs] = await Promise.all([
      queuePrs.length === 0
        ? Promise.resolve([])
        : this.prisma.prReview.findMany({
            where: {
              tenantId,
              repoFullName: {
                in: [...new Set(queuePrs.map((p) => p.repoFullName))],
              },
              externalNumber: {
                in: [...new Set(queuePrs.map((p) => p.externalNumber))],
              },
            },
            select: {
              repoFullName: true,
              externalNumber: true,
              reviewerLogin: true,
              isBot: true,
            },
          }),
      windowReviews.length === 0
        ? Promise.resolve([])
        : this.prisma.pullRequest.findMany({
            where: {
              tenantId,
              repoFullName: {
                in: [...new Set(windowReviews.map((r) => r.repoFullName))],
              },
              externalNumber: {
                in: [...new Set(windowReviews.map((r) => r.externalNumber))],
              },
            },
            select: {
              repoFullName: true,
              externalNumber: true,
              authorLogin: true,
            },
          }),
    ]);

    const authorOfOpen = new Map(
      queuePrs.map((pr) => [prKey(pr), pr.authorLogin] as const),
    );
    const authorOfReviewed = new Map(
      reviewedPrs.map((pr) => [prKey(pr), pr.authorLogin] as const),
    );
    const isBotReview = (r: { isBot: boolean; reviewerLogin: string | null }) =>
      r.isBot || (r.reviewerLogin !== null && isAutomation(r.reviewerLogin));
    const isSelfReview = (
      reviewerLogin: string,
      authorLogin: string | null | undefined,
    ) => !!authorLogin && personOf(reviewerLogin) === personOf(authorLogin);

    // Reviewed = reviewed by a person other than the author. The stored
    // `firstReviewAt` can't answer that: the collector derives it from every
    // review, bots and the author's own reply-in-thread included, so a single
    // Copilot review took a PR out of this queue while nobody had looked at it
    // — the reason Efficiency stopped reading it too (insights.service.ts).
    // Any state counts, dismissed included: a dismissed review was still read.
    const humanReviewed = new Set<string>();
    const botReviewed = new Set<string>();
    for (const review of openReviews) {
      const key = prKey(review);
      if (!authorOfOpen.has(key)) {
        continue; // the superset's cross-product, not one of ours
      }
      if (isBotReview(review)) {
        botReviewed.add(key);
      } else if (
        review.reviewerLogin &&
        !isSelfReview(review.reviewerLogin, authorOfOpen.get(key))
      ) {
        humanReviewed.add(key);
      }
    }

    const now = new Date();
    const waiting: WaitingPr[] = [];
    let open = 0;
    let botAuthored = 0;
    let neverReviewed = 0;
    let botReviewedOnly = 0;
    let waitingOverThreshold = 0;
    let excludedNoReviewData = 0;
    let reviewsFetchedOldest: Date | null = null;
    const tracked = scope
      ? { open: 0, waitingOverThreshold: 0, neverReviewed: 0 }
      : null;
    const oldestWaitByDeveloper = new Map<string, number>();

    for (const pr of queuePrs) {
      if (pr.authorLogin && isAutomation(pr.authorLogin)) {
        botAuthored += 1;
        continue;
      }
      open += 1;
      const person = pr.authorLogin ? personOf(pr.authorLogin) : null;
      const isTracked = person !== null && !!scope?.has(person);
      if (tracked && isTracked) {
        tracked.open += 1;
      }
      if (!pr.reviewsFetchedAt) {
        // "Never asked" is not "never reviewed" — the discriminator the
        // schema keeps `reviewsFetchedAt` for.
        excludedNoReviewData += 1;
        continue;
      }
      if (!reviewsFetchedOldest || pr.reviewsFetchedAt < reviewsFetchedOldest) {
        reviewsFetchedOldest = pr.reviewsFetchedAt;
      }
      const key = prKey(pr);
      if (humanReviewed.has(key)) {
        continue;
      }
      if (botReviewed.has(key)) {
        botReviewedOnly += 1;
      }
      const waitingHours = hoursBetween(pr.openedAt, now);
      const overThreshold = waitingHours >= REVIEW_WAIT_ALERT_HOURS;
      neverReviewed += 1;
      if (overThreshold) {
        waitingOverThreshold += 1;
      }
      if (tracked && isTracked) {
        tracked.neverReviewed += 1;
        if (overThreshold) {
          tracked.waitingOverThreshold += 1;
        }
      }
      if (person) {
        oldestWaitByDeveloper.set(
          person,
          Math.max(oldestWaitByDeveloper.get(person) ?? 0, waitingHours),
        );
      }
      if (!shown(person)) continue;
      waiting.push({
        ref: key,
        repo: pr.repoFullName,
        number: pr.externalNumber,
        title: pr.title,
        author: pr.authorLogin,
        authorDeveloper: person,
        authorDisplayName: person
          ? (index.displayNames.get(person) ?? person)
          : null,
        projects: [],
        additions: pr.additions,
        deletions: pr.deletions,
        openedAt: pr.openedAt.toISOString(),
        waitingHours,
        neverReviewed: true,
      });
    }

    // Ordered by how long the CHANGE has waited — a property of the pull
    // request, not a ranking of the people who opened them.
    waiting.sort((a, b) => b.waitingHours - a.waitingHours);

    const raised = new Map<string, number>();
    for (const pr of windowPrs) {
      if (!pr.authorLogin || isAutomation(pr.authorLogin)) {
        continue;
      }
      const person = personOf(pr.authorLogin);
      raised.set(person, (raised.get(person) ?? 0) + 1);
    }

    const reviewed = new Map<string, number>();
    let reviewsGiven = 0;
    let botReviews = 0;
    let selfReviews = 0;
    for (const review of windowReviews) {
      if (isBotReview(review)) {
        // A bot approving in seconds flatters both coverage and latency while
        // no human has looked at the change (METRICS.md §0).
        botReviews += 1;
        continue;
      }
      if (!review.reviewerLogin) {
        continue;
      }
      // An author answering a thread on their own PR files a COMMENTED review
      // under their own name. That is not review given to the team.
      if (
        isSelfReview(review.reviewerLogin, authorOfReviewed.get(prKey(review)))
      ) {
        selfReviews += 1;
        continue;
      }
      reviewsGiven += 1;
      const person = personOf(review.reviewerLogin);
      reviewed.set(person, (reviewed.get(person) ?? 0) + 1);
    }

    const people = new Set([
      ...raised.keys(),
      ...reviewed.keys(),
      ...oldestWaitByDeveloper.keys(),
    ]);
    const reviewLoad: ReviewLoadRow[] = [...people]
      .filter(shown)
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
        open,
        waitingOverThreshold,
        neverReviewed,
        botReviewedOnly,
        reviewsGiven,
        botReviews,
        selfReviews,
        botAuthored,
      },
      tracked,
      waiting: waiting.slice(0, WAITING_ROWS),
      waitingTotal: waiting.length,
      reviewLoad,
      excludedNoReviewData,
      excludedNoOpenedDate,
      openOutsideRange,
      reviewsFetchedOldestAt: reviewsFetchedOldest?.toISOString() ?? null,
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
      // No exclusion set passed, unlike the roster-wide calls above: this is a
      // drill-down on ONE developer the caller has already named, so the
      // coverage figure is about them. Filtering them out of their own page
      // would report `null` coverage rather than an answer.
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
  /**
   * The admin-stated role per canonical developer.
   *
   * Its own small read rather than a join: the table holds one row per
   * *classified* developer, which on any real tenant is a fraction of the
   * roster and never approaches the size of a commit page. A developer with no
   * row is simply absent from the map, which is what makes "unclassified"
   * expressible at all — the read models turn that absence into `null`, never
   * into `OTH`.
   */
  private async rolesByDeveloper(
    tenantId: string,
  ): Promise<Map<string, DeveloperRoleValue>> {
    const rows = await this.prisma.developerRole.findMany({
      where: { tenantId },
      select: { canonicalDeveloperId: true, role: true },
    });
    const roles = new Map<string, DeveloperRoleValue>();
    for (const row of rows) {
      // Guarded rather than cast: the column is a plain string, so a value
      // written before the set changed (or by hand) must not become a badge
      // the UI cannot render.
      if (isDeveloperRole(row.role)) {
        roles.set(row.canonicalDeveloperId, row.role);
      }
    }
    return roles;
  }

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
 * Who showed a tracked signal in the window, with what they did.
 *
 * The union of commit authors and PR authors — deliberately the same set that
 * produces `totals.developersWithSignal`, so the list *explains* the number
 * printed above it rather than being a second, quietly different definition of
 * "active". A roster built from committers alone would be shorter than its own
 * headline count.
 *
 * Sorted alphabetically, never by volume (CLAUDE.md). The UI's "Most commits"
 * toggle is the reader's explicit act and is never persisted — the same rule
 * the day drill-down follows (DASHBOARDS.md §4.1.3).
 *
 * Absent signals are zeros, not missing keys: a PR-only contributor belongs on
 * the roster, and a blank cell reads as absent data rather than as none.
 */
export function activeDeveloperRoster(
  commitsByDeveloper: ReadonlyMap<string, number>,
  locByDeveloper: ReadonlyMap<string, { additions: number; deletions: number }>,
  prsByDeveloper: ReadonlyMap<string, { opened: number; merged: number }>,
  displayNames: ReadonlyMap<string, string>,
  rolesByDeveloper: ReadonlyMap<string, DeveloperRoleValue> = new Map(),
  mergesByDeveloper: ReadonlyMap<string, number> = new Map(),
  copilot: CopilotLookup | null = null,
): ActiveDeveloper[] {
  // Merge-only contributors belong on the roster too: their merges are a
  // signal (`activeDeveloperSet` counts them), so leaving them off would make
  // the list shorter than the tile it explains. Copilot never changes who is
  // on the roster or where: membership is the delivery-signal definition
  // above, and the order stays alphabetical.
  const everyone = new Set([
    ...commitsByDeveloper.keys(),
    ...prsByDeveloper.keys(),
    ...mergesByDeveloper.keys(),
  ]);
  // Sorted alphabetically, and never by `locChanged`. LOC is the most misread
  // number on this page: ordering by it would make the roster a leaderboard by
  // default, which is exactly what CLAUDE.md forbids.
  return [...everyone]
    .map((developer) => {
      const prs = prsByDeveloper.get(developer);
      const loc = locByDeveloper.get(developer);
      const additions = loc?.additions ?? 0;
      const deletions = loc?.deletions ?? 0;
      return {
        developer,
        displayName: displayNames.get(developer) ?? developer,
        commits: commitsByDeveloper.get(developer) ?? 0,
        additions,
        deletions,
        // The SUM, as everywhere else. A net figure would report a refactor
        // that removed as much as it added as very nearly no work at all.
        locChanged: additions + deletions,
        prsOpened: prs?.opened ?? 0,
        prsMerged: prs?.merged ?? 0,
        mergeCommits: mergesByDeveloper.get(developer) ?? 0,
        // `?? null`, never `?? 'OTH'`. An unclassified developer is not one
        // somebody has decided is "other".
        role: rolesByDeveloper.get(developer) ?? null,
        copilot: copilot ? copilotCell(developer, copilot) : null,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Copilot report rows and seat logins, re-keyed by canonical developer with
 * the same login rule PRs use (`byLogin`, else the login itself). A person
 * under two logins gets the union of their days and the sum of their lines.
 * Logins are matched case-insensitively as a fallback: GitHub logins are, and
 * the report and the commit API needn't agree on case.
 */
export function copilotLookup(
  rows: readonly CopilotUsageRow[],
  seatLogins: readonly string[] | null,
  byLogin: ReadonlyMap<string, string>,
): CopilotLookup {
  const byLower = new Map<string, string>();
  for (const [login, developer] of byLogin) {
    byLower.set(login.toLowerCase(), developer);
  }
  const resolve = (login: string) =>
    byLogin.get(login) ?? byLower.get(login.toLowerCase()) ?? login;

  const acc = new Map<string, { days: Set<string>; linesAdded: number }>();
  for (const row of rows) {
    const developer = resolve(row.login);
    const entry = acc.get(developer) ?? { days: new Set(), linesAdded: 0 };
    if (row.interactions + row.generations + row.acceptances > 0) {
      entry.days.add(row.day);
    }
    entry.linesAdded += row.locAdded;
    acc.set(developer, entry);
  }
  const usage = new Map<string, { activeDays: number; linesAdded: number }>();
  for (const [developer, entry] of acc) {
    usage.set(developer, {
      activeDays: entry.days.size,
      linesAdded: entry.linesAdded,
    });
  }
  return {
    usage,
    seatHolders: seatLogins ? new Set(seatLogins.map(resolve)) : null,
  };
}

/** One developer's Copilot cell — see `DeveloperCopilot` for what each status claims. */
export function copilotCell(
  developer: string,
  lookup: CopilotLookup,
): DeveloperCopilot {
  const usage = lookup.usage.get(developer);
  const activeDays = usage?.activeDays ?? 0;
  const linesAdded = usage?.linesAdded ?? 0;
  if (activeDays > 0) {
    return { status: 'active', activeDays, linesAdded };
  }
  if (!lookup.seatHolders) {
    return { status: 'no_activity', activeDays, linesAdded };
  }
  return {
    status: lookup.seatHolders.has(developer) ? 'seat_unused' : 'no_seat',
    activeDays,
    linesAdded,
  };
}

/**
 * Whose commit this is. A login is an identity even before the resolution pass
 * has seen it; only a commit with neither a known login nor a known email is
 * genuinely unattributable.
 */
/** One IST day of commit activity, as the Overview's daily chart reads it. */
export interface ActivityDay {
  date: string;
  totalCommits: number;
  /** Team totals for the day: lines added, removed, and their sum. Volume, never productivity. */
  additions: number;
  deletions: number;
  locChanged: number;
  /**
   * Commits that recorded no line changes at all — commits whose line stats
   * have not been collected yet, or that change no lines. Disclosed so a reader can
   * tell when the day's LOC figure is partial; never read as "no work".
   */
  commitsWithoutLineChanges: number;
  /**
   * Merge commits that day, left out of `totalCommits`, the LOC fields and
   * the contributor counts (METRICS.md §0) — disclosed, never silently dropped.
   */
  mergeCommitsExcluded: number;
  developers: { developer: string; displayName: string; commits: number }[];
  unattributedCommits: number;
}

/**
 * Buckets commits into IST days with commit counts, changed-LOC totals and the
 * day's contributors. Unattributed commits count toward the day's totals
 * (the code changed regardless of who it is credited to) and are disclosed
 * separately.
 *
 * Contributors carry commit counts only and are alphabetical (CLAUDE.md — no
 * volume ranking); per-person LOC is deliberately not part of the day
 * drill-down. Days are newest first.
 */
export function commitDays(
  commits: {
    authorLogin: string | null;
    authorEmail: string | null;
    committedAt: Date | null;
    authoredAt: Date;
    additions: number;
    deletions: number;
    parentCount?: number | null;
  }[],
  index: {
    byLogin: Map<string, string>;
    byEmail: Map<string, string>;
    displayNames: Map<string, string>;
  },
): ActivityDay[] {
  interface DayAcc {
    total: number;
    additions: number;
    deletions: number;
    withoutLineChanges: number;
    merges: number;
    unattributed: number;
    byDeveloper: Map<string, number>;
  }
  const byDay = new Map<string, DayAcc>();
  for (const c of commits) {
    const day = istDateKey(c.committedAt ?? c.authoredAt);
    const acc = byDay.get(day) ?? {
      total: 0,
      additions: 0,
      deletions: 0,
      withoutLineChanges: 0,
      merges: 0,
      unattributed: 0,
      byDeveloper: new Map<string, number>(),
    };
    byDay.set(day, acc);
    if (isMergeCommit(c)) {
      acc.merges += 1;
      continue;
    }
    acc.total += 1;
    acc.additions += c.additions;
    acc.deletions += c.deletions;
    if (c.additions === 0 && c.deletions === 0) {
      acc.withoutLineChanges += 1;
    }
    const person = attributeCommit(c, index);
    if (person) {
      acc.byDeveloper.set(person, (acc.byDeveloper.get(person) ?? 0) + 1);
    } else {
      acc.unattributed += 1;
    }
    byDay.set(day, acc);
  }
  return [...byDay.entries()]
    .map(([date, acc]) => ({
      date,
      totalCommits: acc.total,
      additions: acc.additions,
      deletions: acc.deletions,
      locChanged: acc.additions + acc.deletions,
      commitsWithoutLineChanges: acc.withoutLineChanges,
      mergeCommitsExcluded: acc.merges,
      developers: [...acc.byDeveloper.entries()]
        .map(([developer, count]) => ({
          developer,
          displayName: index.displayNames.get(developer) ?? developer,
          commits: count,
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      unattributedCommits: acc.unattributed,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function attributeCommit(
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

/**
 * Who had a delivery signal in a window: commit authors ∪ PR authors.
 *
 * **The single definition of "active", used by both the Activity Overview
 * board and the daily digest notification.** It exists as one function
 * because these are the same claim on two surfaces, and the codebase has
 * already paid once for computing one number in two places — see the comment
 * above `planningGapDevelopers`, where Overview and Watchlist disagreed on
 * real data (3 versus 0).
 *
 * That matters more for the digest than for the board: the digest NAMES the
 * people who are absent from this set, so any signal the board counts and the
 * digest does not becomes a person wrongly named in a Teams channel. Widening
 * this set is a legitimate improvement; widening it for only one caller is
 * not, and is impossible while both go through here.
 */
export function activeDeveloperSet(
  commits: readonly {
    authorLogin: string | null;
    authorEmail: string | null;
  }[],
  prs: readonly { authorLogin: string | null }[],
  index: { byLogin: Map<string, string>; byEmail: Map<string, string> },
): Set<string> {
  const active = new Set<string>();
  for (const commit of commits) {
    const person = attributeCommit(commit, index);
    if (person) {
      active.add(person);
    }
  }
  for (const pr of prs) {
    if (pr.authorLogin) {
      // Same fallback `attributeCommit` uses: a login is an identity even
      // before the resolution pass has reached it.
      active.add(index.byLogin.get(pr.authorLogin) ?? pr.authorLogin);
    }
  }
  return active;
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
