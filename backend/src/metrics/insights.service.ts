import { Injectable } from '@nestjs/common';
import { PullRequest, Sprint, Story } from '@prisma/client';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { istDateKey, istWeekKey } from '../common/time';
import { CorrelationService } from '../correlation/correlation.service';
import {
  AttributionCoverage,
  DeveloperIdentityService,
} from '../correlation/developer-identity.service';
import { CodeService } from '../modules/code/code.service';
import { ConnectionsService } from '../modules/connections/connections.service';
import {
  DONE_STATUSES,
  PlanningService,
  WorkItemFilters,
} from '../modules/planning/planning.service';

/** One work item with its bi-directional GitHub linkage (Jira → PRs). */
export interface WorkItemView {
  key: string;
  title: string;
  type: string;
  status: string;
  done: boolean;
  storyPoints: number | null;
  assigneeName: string | null;
  epicKey: string | null;
  parentKey: string | null;
  sprintExternalId: string | null;
  releases: string[];
  resolvedAt: string | null;
  linkedPrs: { ref: string; state: string | null }[];
}

export interface SprintSummary {
  externalId: string;
  name: string;
  state: string;
  projectKey: string;
  startAt: string | null;
  endAt: string | null;
}

/**
 * Cadence-normalized pace: completion% compared against elapsed% of the
 * sprint's OWN window, so a 1-week and a 3-week sprint are comparable even
 * though every project runs its own sprint lifecycle.
 */
export type SprintPace = 'on-track' | 'at-risk' | 'behind' | 'unknown';

export interface SprintHealthView {
  sprint: SprintSummary;
  committedPoints: number;
  completedPoints: number;
  completionPct: number | null;
  elapsedPct: number | null;
  pace: SprintPace;
  itemsTotal: number;
  itemsDone: number;
  unestimatedItems: number;
  itemsWithCode: number;
  codeLinkagePct: number | null;
  daysRemaining: number | null;
  byType: { type: string; total: number; done: number }[];
}

/**
 * A sprint Jira still calls active whose end date is long past — surfaced so
 * someone closes it, rather than silently dropped or silently counted.
 */
export interface StaleSprint {
  sprint: SprintSummary;
  daysPastEnd: number;
}

export interface ActiveSprintsHealthView {
  rows: SprintHealthView[];
  stale: StaleSprint[];
  staleGraceDays: number;
}

export interface ActiveSprintsRiskView {
  rows: SprintRiskView[];
  stale: StaleSprint[];
  staleGraceDays: number;
}

export interface SprintRiskView {
  sprint: SprintSummary;
  openWithoutCode: WorkItemView[];
  openBugs: number;
  unestimatedOpen: number;
  atRiskPoints: number;
}

export interface VelocityRow {
  sprint: SprintSummary;
  committedPoints: number;
  completedPoints: number;
  itemsTotal: number;
  itemsDone: number;
  /**
   * Items carrying no estimate. These are invisible to `committedPoints` and
   * `completedPoints` entirely, so without this the points figures look like
   * they describe the sprint when they describe a subset of it.
   */
  unestimatedItems: number;
  /** Share of the sprint's items that carry an estimate at all. */
  estimateCoveragePct: number | null;
  /**
   * Still running. Its points are partial by definition and comparing them to
   * a finished sprint's understates it — shown, but never averaged into
   * velocity and never fed to the forecast.
   */
  inProgress: boolean;
  /** How far through its own window, for reading a partial sprint fairly. */
  elapsedPct: number | null;
  /**
   * The sprint ended before the Jira collection floor, so only the few of its
   * items touched since then were ever fetched — its counts are a fraction of
   * what the sprint actually held. Shown, but never averaged: on a real project
   * this dragged the reported velocity from 475 items per sprint to 241, and
   * made Velocity and Forecasting disagree by 2x purely because one sampled six
   * sprints across the floor and the other sampled three inside it.
   */
  beyondHorizon: boolean;
}

/**
 * Velocity for ONE project. Velocity is only meaningful within a project —
 * teams estimate on their own scales, so pooling sprints from several projects
 * into one series produces a chart whose bars cannot be compared to each other.
 */
export interface ProjectVelocity {
  projectKey: string;
  /** Current → past: the in-flight sprint first, then closed ones newest-first. */
  rows: VelocityRow[];
  /** Mean over CLOSED sprints only. */
  avgCompletedPoints: number | null;
  /** Mean items completed over closed sprints — see `pointsReliable`. */
  avgCompletedItems: number | null;
  /** Closed sprints the averages are actually built from (horizon-excluded ones aren't). */
  closedSprintsSampled: number;
  /**
   * Sprints shown but excluded from the averages because they closed before the
   * collection floor. Non-zero means this project's history predates the data,
   * and deepening the backfill window is what fixes it.
   */
  sprintsBeyondHorizon: number;
  /** Estimate coverage across the sampled closed sprints. */
  estimateCoveragePct: number | null;
  /**
   * False when too few items carry estimates for the points figures to describe
   * the sprint. On a real project this read 25%: three-quarters of the work was
   * unestimated, the completed items were overwhelmingly the unestimated ones,
   * and "velocity" came out at ~2% of committed points while 76% of the sprint's
   * items were finished. Throughput is the honest signal at that coverage.
   */
  pointsReliable: boolean;
}

export interface ForecastView {
  projectKey: string;
  sprintsSampled: number;
  avgVelocityPoints: number | null;
  remainingPoints: number;
  remainingItems: number;
  unestimatedItems: number;
  sprintsNeeded: number | null;
  projectedDate: string | null;
  assumedSprintDays: number;
  /**
   * The same projection run on item counts instead of points.
   *
   * Present because a points projection is only as good as its estimates. Where
   * most of the backlog is unestimated, the points forecast silently answers a
   * different question — "when will the estimated quarter be done?" — while the
   * item forecast still answers the one that was asked.
   */
  avgVelocityItems: number | null;
  sprintsNeededByItems: number | null;
  projectedDateByItems: string | null;
  /** Estimate coverage of the sampled sprints. */
  estimateCoveragePct: number | null;
  /**
   * False when coverage is too low for the points projection to mean anything.
   * On a real project the points path produced ~181 sprints (about 15 years)
   * purely because the completed work was the unestimated work; the item path
   * on the same data is an ordinary number.
   */
  pointsReliable: boolean;
}

export interface ProductivityWeek {
  weekStart: string;
  itemsCompleted: number;
  pointsCompleted: number;
  prsMerged: number;
  locChanged: number;
}

export interface EfficiencyView {
  prCycle: {
    sampleSize: number;
    p50Hours: number | null;
    p85Hours: number | null;
  };
  storyCycle: {
    sampleSize: number;
    p50Days: number | null;
    p85Days: number | null;
    /**
     * Resolved items carrying no Jira creation date, so lead time can't be
     * measured for them. Disclosed rather than silently narrowing the
     * denominator — see `computeEfficiency`.
     */
    excludedNoCreatedAt: number;
  };
  traceability: {
    storiesWithCodePct: number | null; // Jira → GitHub direction
    prsWithStoryPct: number | null; // GitHub → Jira direction
    storiesTotal: number;
    prsTotal: number;
  };
  /**
   * Review Quality (METRICS.md §3) + the pr_cycle_time sub-phases, all from
   * the collected `pr_review` timeline. Bot reviews are excluded from every
   * figure here and reported separately (METRICS.md §0 exclusions).
   */
  review: {
    /** Merged PRs with at least one review — the denominator for the rest. */
    mergedWithReviewPct: number | null;
    mergedTotal: number;
    /** Merged PRs whose reviews we haven't collected yet; excluded from the percentages. */
    excludedNoReviewData: number;
    timeToFirstReview: {
      sampleSize: number;
      p50Hours: number | null;
      p85Hours: number | null;
    };
    /** first review → first approval. */
    reviewTime: { sampleSize: number; p50Hours: number | null };
    /** first approval → merge. */
    mergeTime: { sampleSize: number; p50Hours: number | null };
    /** Merged by the author with no approval from anyone else. */
    selfMergedPct: number | null;
    selfMergedCount: number;
    /**
     * PRs where the merger is actually known. `merged_by` only arrives on the
     * PR detail call, so PRs reconciled for reviews alone don't have it — they
     * are excluded from the self-merge rate rather than counted as "not a
     * self-merge", which would dilute it toward zero.
     */
    selfMergeSampleSize: number;
    /** Distinct reviewers, and the busiest one's share — a bottleneck/bus-factor signal. */
    reviewerCount: number;
    topReviewerSharePct: number | null;
    /**
     * Bot reviews, excluded from every figure above and reported separately.
     * A bot approving in seconds otherwise flatters both review coverage and
     * review latency while no human has looked at the change.
     */
    botReviews: number;
    /** Merged PRs whose ONLY review was automated — reviewed on paper, not in practice. */
    botOnlyReviewedPrs: number;
    /** Inline comments per merged PR (human reviews only). */
    reviewDepth: { sampleSize: number; p50Comments: number | null };
    /**
     * Large PRs approved by a human without a single inline comment.
     * Only counts PRs whose comments were actually counted.
     */
    rubberStamp: {
      sampleSize: number;
      count: number;
      pct: number | null;
      sizeThreshold: number;
    };
  };
}

/**
 * A completion faster than this isn't work finishing — it's someone clicking an
 * item through several workflow states in one action. Observed on a real site
 * as ~48% of all completions, so counting them would report a p50 cycle time of
 * zero and make the whole metric useless.
 */
const INSTANT_COMPLETION_SECONDS = 60;

/**
 * `rubber_stamp_rate` only asks its question of PRs big enough that a silent
 * approval is notable. A one-line fix approved without comment is not a
 * rubber stamp. Tenant-configurable once the metric-config surface exists
 * (METRICS.md §0 exclusions).
 */
const RUBBER_STAMP_SIZE_THRESHOLD = 200;

/**
 * Flow metrics derived from `issue_status_history` (METRICS.md: cycle_time,
 * wip/wip_age, aging_work_items). Distinct from the `storyCycle` in
 * `EfficiencyView`, which is `resolvedAt - sourceCreatedAt` — that's lead_time,
 * and it counts backlog sitting time as if it were work.
 */
export interface FlowMetricsView {
  cycleTime: {
    sampleSize: number;
    p50Days: number | null;
    p85Days: number | null;
    /**
     * Completions where in-progress and done landed within
     * `instantThresholdSeconds` of each other. These are workflow
     * book-keeping — someone clicking an item through several states in one
     * action — not work taking no time, so they're excluded from the
     * percentiles above and reported here instead. On a real site this can be
     * ~half of all completions, which would otherwise drag p50 to zero and
     * make the metric read as instant delivery.
     */
    excludedInstant: number;
    instantThresholdSeconds: number;
  };
  wip: {
    count: number;
    /** Age since entering work, for items currently in progress. */
    p50Days: number | null;
    p85Days: number | null;
    oldestDays: number | null;
  };
  aging: {
    /** In-progress items sitting in their current status beyond the threshold. */
    thresholdDays: number;
    count: number;
    items: {
      externalKey: string;
      projectKey: string;
      status: string;
      daysInStatus: number;
    }[];
  };
  /**
   * How much of the scope this is actually computable for. Flow metrics are
   * only as good as the transition history behind them: items collected before
   * transitions existed, or whose statuses aren't in the site catalog, have no
   * timeline and are excluded rather than counted as zero.
   */
  coverage: {
    itemsInScope: number;
    itemsWithHistory: number;
    coveragePct: number | null;
  };
}

export interface ProjectActivityRow {
  projectKey: string; // '(unlinked repos)' bucket for repos mapped to no project
  commits: number;
  locChanged: number;
  additions: number;
  deletions: number;
  activeRepos: number;
  topRepo: string | null;
  contributors: number;
  /**
   * Commits in this row whose author matched no developer. They ARE counted in
   * `commits` and `locChanged` but cannot be counted in `contributors`, so
   * without this the row silently reports more work than people to do it.
   */
  unattributedCommits: number;
  /** Per-day activity (sparse: only days with commits). */
  dailySeries: { date: string; commits: number; locChanged: number }[];
}

export interface ProjectActivityView {
  rows: ProjectActivityRow[];
  /** How much of the window's commit volume is attributable at all. */
  attribution: AttributionCoverage;
  /**
   * True when the underlying commit read hit its ceiling, so these totals cover
   * only the most recent slice of the window. Reported rather than silently
   * changing every number on the board.
   */
  truncated: boolean;
}

/**
 * Which source identities this developer's numbers were gathered under.
 *
 * Shown on the board because the figures are only as trustworthy as the
 * identity behind them: a person whose git email is not verified on their
 * GitHub account commits under a login-less identity, and until it is resolved
 * their page reads "0 commits" (CLAUDE.md — always surface linkage coverage).
 */
export interface DeveloperIdentityNote {
  /** Logins whose commits/PRs are counted here. */
  logins: string[];
  /** Git emails counted here because GitHub attributed no account to them. */
  recoveredEmails: string[];
  /** True when any figure below rests on an inferred identity, not a source-resolved one. */
  inferred: boolean;
}

export interface DeveloperActivityView {
  developer: string;
  totals: {
    commits: number;
    additions: number;
    deletions: number;
    locChanged: number;
    filesChanged: number;
    prsAuthored: number;
    /** PRs authored in the window that were merged — the Delivery Explorer denominator. */
    prsMerged: number;
    activeRepos: number;
  };
  identity: DeveloperIdentityNote;
  activeProjects: string[]; // via repo→project graph mapping
  byRepo: {
    repo: string;
    commits: number;
    locChanged: number;
    lastCommitAt: string;
  }[];
  dailySeries: { date: string; commits: number; locChanged: number }[];
  recentCommits: {
    sha: string;
    repo: string;
    message: string;
    authoredAt: string;
    /** When the commit actually landed (committer date) — differs from `authoredAt` on a rebase/cherry-pick/amend. */
    committedAt: string;
    additions: number;
    deletions: number;
  }[];
}

const DEFAULT_SPRINT_DAYS = 14;

/**
 * How far past its own end date a sprint can still be called "active" before we
 * stop believing the label.
 *
 * Jira's `state` is whatever someone last set; nothing closes a sprint
 * automatically. A team that stops using a board leaves its final sprint
 * `active` forever — on this tenant one had been "active" for over four years,
 * and it rendered as a live card at 100% elapsed, 0 days remaining, pace
 * "behind", permanently, next to the sprint actually running.
 *
 * The grace period exists because running a few days past the planned end is
 * ordinary; four years is not. Stale sprints are reported separately rather
 * than dropped — the sprint is real and someone should close it in Jira, so
 * hiding it would trade a misleading card for a silent omission.
 */
const STALE_ACTIVE_SPRINT_GRACE_DAYS = 14;

/**
 * Estimate coverage below which story points stop describing a sprint.
 *
 * Not a stylistic threshold — on a real project this read 25%: three-quarters
 * of items carried no estimate, the items actually being completed were
 * overwhelmingly those unestimated ones, and "completed points" came out at
 * ~2% of committed while 76% of the sprint's items were finished. A velocity
 * chart built on that is not a pessimistic reading, it is a different quantity
 * wearing velocity's label. Above the floor the points are worth trusting;
 * below it the board leads with throughput and says why.
 */
const MIN_ESTIMATE_COVERAGE_PCT = 70;

/** True when Jira still calls this sprint active but its end date is long past. */
function isStaleActive(sprint: Sprint, now = Date.now()): boolean {
  if (sprint.state !== 'active' || !sprint.endAt) {
    return false;
  }
  const daysPast = (now - sprint.endAt.getTime()) / 86_400_000;
  return daysPast > STALE_ACTIVE_SPRINT_GRACE_DAYS;
}

/**
 * BC-8 insight read models behind the common dashboards (Sprint Health, Sprint
 * Risk, Velocity, Forecast, Productivity, Efficiency) plus work-item detailing
 * at every granularity (story/bug/subtask/epic/developer/release/sprint) with
 * bi-directional Jira↔GitHub traceability. Read-only; numbers are computed from
 * persisted facts + correlation links — never fabricated.
 */
@Injectable()
export class InsightsService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly planning: PlanningService,
    private readonly code: CodeService,
    private readonly correlation: CorrelationService,
    private readonly identities: DeveloperIdentityService,
    private readonly connections: ConnectionsService,
  ) {}

  /** Work-item detail rows (any granularity) with linked PRs per item. */
  async workItems(filters: WorkItemFilters): Promise<WorkItemView[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const items = await this.planning.listWorkItems(tenantId, filters);
    return this.toViews(tenantId, items);
  }

  async sprintHealth(
    sprintExternalId: string,
  ): Promise<SprintHealthView | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const sprint = await this.findSprint(tenantId, sprintExternalId);
    if (!sprint) {
      return null;
    }
    return this.buildSprintHealth(tenantId, sprint);
  }

  /**
   * Health for EVERY active sprint in scope — the multi-project answer: each
   * project runs its own sprint lifecycle, so the default view is one card per
   * concurrent active sprint, ranked worst-pace-first.
   */
  async activeSprintsHealth(
    projectKeys: string[],
  ): Promise<ActiveSprintsHealthView> {
    const tenantId = this.tenantContext.requireTenantId();
    const sprints = await this.planning.listSprints(
      tenantId,
      projectKeys,
      'active',
    );
    // Split before computing: a sprint that ended years ago is not a live
    // lifecycle, and ranking it against real ones by "pace" is meaningless —
    // it is 100% elapsed by definition, so it always sorts to the top of a
    // worst-first list and pushes the sprint that needs attention down.
    const live = sprints.filter((s) => !isStaleActive(s));
    const stale = sprints.filter((s) => isStaleActive(s));

    const views = await Promise.all(
      live.map((s) => this.buildSprintHealth(tenantId, s)),
    );
    const paceRank: Record<SprintPace, number> = {
      behind: 0,
      'at-risk': 1,
      unknown: 2,
      'on-track': 3,
    };
    return {
      rows: views.sort(
        (a, b) =>
          paceRank[a.pace] - paceRank[b.pace] ||
          (a.completionPct ?? 0) - (b.completionPct ?? 0),
      ),
      stale: stale.map(toStaleSprint),
      staleGraceDays: STALE_ACTIVE_SPRINT_GRACE_DAYS,
    };
  }

  private async buildSprintHealth(
    tenantId: string,
    sprint: Sprint,
  ): Promise<SprintHealthView> {
    const items = (
      await this.planning.listItemsForSprint(tenantId, sprint.externalId)
    ).filter((i) => i.type !== 'epic');
    const views = await this.toViews(tenantId, items);

    const done = views.filter((v) => v.done);
    const committedPoints = sumPoints(views);
    const completedPoints = sumPoints(done);
    const estimable = views.filter((v) => v.storyPoints !== null);
    const withCode = views.filter((v) => v.linkedPrs.length > 0);

    const byTypeMap = new Map<string, { total: number; done: number }>();
    for (const v of views) {
      const t = byTypeMap.get(v.type) ?? { total: 0, done: 0 };
      t.total += 1;
      if (v.done) t.done += 1;
      byTypeMap.set(v.type, t);
    }

    const completionPct = pct(completedPoints, committedPoints);
    const elapsedPct = sprintElapsedPct(sprint);

    return {
      sprint: toSprintSummary(sprint),
      committedPoints,
      completedPoints,
      completionPct,
      elapsedPct,
      pace: paceOf(sprint.state, completionPct, elapsedPct),
      itemsTotal: views.length,
      itemsDone: done.length,
      unestimatedItems: views.length - estimable.length,
      itemsWithCode: withCode.length,
      codeLinkagePct: pct(withCode.length, views.length),
      daysRemaining: sprint.endAt
        ? Math.max(
            0,
            Math.ceil((sprint.endAt.getTime() - Date.now()) / 86_400_000),
          )
        : null,
      byType: [...byTypeMap.entries()].map(([type, t]) => ({ type, ...t })),
    };
  }

  async sprintRisk(sprintExternalId: string): Promise<SprintRiskView | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const sprint = await this.findSprint(tenantId, sprintExternalId);
    if (!sprint) {
      return null;
    }
    return this.buildSprintRisk(tenantId, sprint);
  }

  /**
   * Risk for EVERY active sprint in scope (multi-project lifecycles), ranked
   * most-at-risk-first — the default view mirrors activeSprintsHealth.
   */
  async activeSprintsRisk(
    projectKeys: string[],
  ): Promise<ActiveSprintsRiskView> {
    const tenantId = this.tenantContext.requireTenantId();
    const sprints = await this.planning.listSprints(
      tenantId,
      projectKeys,
      'active',
    );
    // Same split as activeSprintsHealth — an abandoned sprint's open items are
    // not "at risk", they are simply never going to be done, and ranking them
    // first buries the sprint someone can still act on.
    const live = sprints.filter((s) => !isStaleActive(s));
    const stale = sprints.filter((s) => isStaleActive(s));

    const views = await Promise.all(
      live.map((s) => this.buildSprintRisk(tenantId, s)),
    );
    return {
      rows: views.sort(
        (a, b) =>
          b.atRiskPoints - a.atRiskPoints ||
          b.openWithoutCode.length - a.openWithoutCode.length ||
          b.openBugs - a.openBugs,
      ),
      stale: stale.map(toStaleSprint),
      staleGraceDays: STALE_ACTIVE_SPRINT_GRACE_DAYS,
    };
  }

  private async buildSprintRisk(
    tenantId: string,
    sprint: Sprint,
  ): Promise<SprintRiskView> {
    const items = (
      await this.planning.listItemsForSprint(tenantId, sprint.externalId)
    ).filter((i) => i.type !== 'epic');
    const views = await this.toViews(tenantId, items);
    const open = views.filter((v) => !v.done);
    const openWithoutCode = open.filter((v) => v.linkedPrs.length === 0);

    return {
      sprint: toSprintSummary(sprint),
      openWithoutCode,
      openBugs: open.filter((v) => v.type === 'bug').length,
      unestimatedOpen: open.filter((v) => v.storyPoints === null).length,
      atRiskPoints: sumPoints(openWithoutCode),
    };
  }

  /**
   * Velocity, grouped by project and ordered current → past.
   *
   * Grouped because velocity does not survive being pooled: each team estimates
   * on its own scale, so a single series mixing several projects' sprints
   * invites comparisons between bars that mean different things. The in-flight
   * sprint leads each group so the board answers "how are we doing now?" before
   * "how did we do?", but it is excluded from every average — a sprint halfway
   * through has completed half its work by definition.
   */
  async velocity(projectKeys: string[], limit = 6): Promise<ProjectVelocity[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const sprints = await this.planning.listSprints(tenantId, projectKeys);
    // Nothing before this was ever collected, so a sprint that closed earlier
    // holds only whatever has been touched since — see `beyondHorizon`.
    const horizon = await this.jiraHorizon(tenantId);

    const byProject = new Map<string, Sprint[]>();
    for (const sprint of sprints) {
      // `future` sprints have no dates and nothing in them — there is no
      // velocity to report for work that hasn't started.
      if (sprint.state === 'future' || isStaleActive(sprint)) {
        continue;
      }
      byProject.set(sprint.projectKey, [
        ...(byProject.get(sprint.projectKey) ?? []),
        sprint,
      ]);
    }

    const out: ProjectVelocity[] = [];
    for (const [projectKey, projectSprints] of byProject) {
      // listSprints already orders endAt desc; the running sprint ends latest
      // so it naturally leads, but sort explicitly rather than rely on that.
      const ordered = [...projectSprints].sort(
        (a, b) =>
          Number(b.state === 'active') - Number(a.state === 'active') ||
          (b.endAt?.getTime() ?? 0) - (a.endAt?.getTime() ?? 0),
      );
      // The limit counts CLOSED sprints, so adding the in-flight one never
      // pushes a closed sprint out of the history it is meant to show.
      const active = ordered.filter((s) => s.state === 'active');
      const closed = ordered
        .filter((s) => s.state !== 'active')
        .slice(0, limit);

      const rows: VelocityRow[] = [];
      for (const sprint of [...active, ...closed]) {
        rows.push(await this.buildVelocityRow(tenantId, sprint, horizon));
      }
      out.push(summarizeVelocity(projectKey, rows));
    }

    // Projects with the most recent activity first — with 17 projects carrying
    // sprints and most holding exactly one, recency is what makes the top of
    // the page the part worth reading.
    return out.sort(
      (a, b) =>
        (latestEnd(b.rows) ?? 0) - (latestEnd(a.rows) ?? 0) ||
        a.projectKey.localeCompare(b.projectKey),
    );
  }

  /** Newest Jira backfill floor — the point before which coverage stops. */
  private async jiraHorizon(tenantId: string): Promise<Date | null> {
    const horizon = await this.connections.getDataHorizon(tenantId);
    return horizon.jira ? new Date(horizon.jira) : null;
  }

  private async buildVelocityRow(
    tenantId: string,
    sprint: Sprint,
    horizon: Date | null,
  ): Promise<VelocityRow> {
    const items = (
      await this.planning.listItemsForSprint(tenantId, sprint.externalId)
    ).filter((i) => i.type !== 'epic');
    const done = items.filter((i) => isDone(i));
    const estimated = items.filter((i) => i.storyPoints !== null);

    return {
      sprint: toSprintSummary(sprint),
      committedPoints: sumStoryPoints(items),
      completedPoints: sumStoryPoints(done),
      itemsTotal: items.length,
      itemsDone: done.length,
      unestimatedItems: items.length - estimated.length,
      estimateCoveragePct: pct(estimated.length, items.length),
      inProgress: sprint.state === 'active',
      elapsedPct: sprintElapsedPct(sprint),
      beyondHorizon: Boolean(horizon && sprint.endAt && sprint.endAt < horizon),
    };
  }

  /** Naive-but-honest forecast: avg velocity of closed sprints vs open backlog. */
  async forecast(projectKeys: string[]): Promise<ForecastView[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const projects =
      projectKeys.length > 0
        ? projectKeys
        : await this.planning.listProjectKeys(tenantId);

    const out: ForecastView[] = [];
    for (const projectKey of projects) {
      const [group] = await this.velocity([projectKey], 3);
      // Closed sprints only. `velocity` now leads each project with the
      // in-flight sprint, whose partial completion would otherwise drag the
      // average down by however far through it happens to be today.
      const closed = (group?.rows ?? []).filter((r) => !r.inProgress);
      // `committedPoints > 0`, not `completedPoints > 0`: a sprint that had
      // estimated work and finished none of it is a real zero and belongs in
      // the average; a sprint nobody estimated has no velocity to contribute.
      // Matches `summarizeVelocity` so both boards quote the same figure.
      const pointSample = closed.filter((r) => r.committedPoints > 0);
      const itemSample = closed.filter((r) => r.itemsTotal > 0);

      const avgPoints = meanOf(pointSample.map((r) => r.completedPoints));
      const avgItems = meanOf(itemSample.map((r) => r.itemsDone));

      const backlog = await this.planning.listOpenBacklog(tenantId, [
        projectKey,
      ]);
      const remainingPoints = sumStoryPoints(backlog);
      const sprintDays = await this.avgSprintDays(tenantId, projectKey);

      const sprintsNeeded =
        avgPoints && avgPoints > 0
          ? Math.ceil(remainingPoints / avgPoints)
          : null;
      const sprintsNeededByItems =
        avgItems && avgItems > 0 ? Math.ceil(backlog.length / avgItems) : null;
      const projectDate = (sprints: number | null) =>
        sprints === null
          ? null
          : new Date(
              Date.now() + sprints * sprintDays * 86_400_000,
            ).toISOString();

      out.push({
        projectKey,
        sprintsSampled: pointSample.length,
        avgVelocityPoints: avgPoints,
        remainingPoints,
        remainingItems: backlog.length,
        unestimatedItems: backlog.filter((b) => b.storyPoints === null).length,
        sprintsNeeded,
        projectedDate: projectDate(sprintsNeeded),
        assumedSprintDays: sprintDays,
        avgVelocityItems: avgItems,
        sprintsNeededByItems,
        projectedDateByItems: projectDate(sprintsNeededByItems),
        estimateCoveragePct: group?.estimateCoveragePct ?? null,
        pointsReliable: group?.pointsReliable ?? false,
      });
    }
    return out;
  }

  /** Weekly throughput: completed items/points (Jira) + merged PRs/LOC (GitHub). */
  async productivity(
    projectKeys: string[],
    repos: string[],
    from: Date,
    to?: Date,
  ): Promise<ProductivityWeek[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const end = to ?? new Date();

    // Uncapped: this is summed per week, so a display cap would under-report
    // throughput while still presenting it as the whole window.
    const items = await this.planning.listAllWorkItems(tenantId, {
      projects: projectKeys,
      from,
      to: end,
    });
    const doneItems = items.filter(
      (i) => i.type !== 'epic' && isDone(i) && i.resolvedAt,
    );
    const prs = (
      await this.code.listDashboardPullRequests(tenantId, repos, from, end)
    ).filter((pr) => pr.mergedAt);

    const weeks = new Map<string, ProductivityWeek>();
    // Weeks start on the IST Sunday, not the UTC one. Bucketing on UTC put
    // work done on a Sunday morning IST into the previous week, and made this
    // the third date convention in the app alongside the IST activity boards
    // and the (now also IST) scope window.
    const bucket = (d: Date) => istWeekKey(d);
    const ensure = (w: string) => {
      const cur = weeks.get(w) ?? {
        weekStart: w,
        itemsCompleted: 0,
        pointsCompleted: 0,
        prsMerged: 0,
        locChanged: 0,
      };
      weeks.set(w, cur);
      return cur;
    };
    for (const item of doneItems) {
      const w = ensure(bucket(item.resolvedAt!));
      w.itemsCompleted += 1;
      w.pointsCompleted += item.storyPoints ?? 0;
    }
    for (const pr of prs) {
      const w = ensure(bucket(pr.mergedAt!));
      w.prsMerged += 1;
      w.locChanged += pr.additions + pr.deletions;
    }
    return [...weeks.values()].sort((a, b) =>
      a.weekStart.localeCompare(b.weekStart),
    );
  }

  /** Cycle times + bi-directional Jira↔GitHub traceability for the scope. */
  async efficiency(
    projectKeys: string[],
    repos: string[],
    from: Date,
    to?: Date,
  ): Promise<EfficiencyView> {
    const tenantId = this.tenantContext.requireTenantId();
    const end = to ?? new Date();

    const prs = await this.code.listDashboardPullRequests(
      tenantId,
      repos,
      from,
      end,
    );
    const merged = prs.filter((pr) => pr.mergedAt && pr.openedAt);
    const prHours = merged
      .map(
        (pr) => (pr.mergedAt!.getTime() - pr.openedAt!.getTime()) / 3_600_000,
      )
      .filter((h) => h >= 0)
      .sort((a, b) => a - b);

    // Uncapped: `storiesTotal` and the traceability percentages below are
    // denominators over the whole scope, not a page of it.
    const items = (
      await this.planning.listAllWorkItems(tenantId, {
        projects: projectKeys,
        from,
        to: end,
      })
    ).filter((i) => i.type !== 'epic');
    const resolved = items.filter((i) => i.resolvedAt);
    // lead_time is `resolvedAt - sourceCreatedAt` (Jira's own creation date).
    // It is NOT measured from the row's `createdAt`, which is when the backfill
    // inserted it: for any item that existed before we first collected it, that
    // is the day of the backfill, making every historical item look days old
    // instead of months. Those came out negative and were dropped by a `>= 0`
    // filter, so the metric quietly reported a p50 over whichever handful of
    // items happened to be created AFTER ingestion started.
    //
    // Items with no `sourceCreatedAt` (collected before the field was
    // requested, and not yet re-walked) are counted and reported instead of
    // being estimated from anything.
    const withCreated = resolved.filter((i) => i.sourceCreatedAt);
    const storyDays = withCreated
      .map(
        (i) =>
          (i.resolvedAt!.getTime() - i.sourceCreatedAt!.getTime()) / 86_400_000,
      )
      .filter((d) => d >= 0)
      .sort((a, b) => a - b);

    const linkByStory = await this.correlation.prRefsByStoryId(
      tenantId,
      items.map((i) => i.id),
    );
    const storiesWithCode = items.filter(
      (i) => (linkByStory.get(i.id) ?? []).length > 0,
    ).length;
    const linkedRefs = new Set(
      [...linkByStory.values()].flat().map((r) => r.toLowerCase()),
    );
    const prsWithStory = prs.filter((pr) =>
      linkedRefs.has(`${pr.repoFullName}#${pr.externalNumber}`.toLowerCase()),
    ).length;

    return {
      prCycle: {
        sampleSize: prHours.length,
        p50Hours: round2(percentile(prHours, 50)),
        p85Hours: round2(percentile(prHours, 85)),
      },
      storyCycle: {
        sampleSize: storyDays.length,
        p50Days: round2(percentile(storyDays, 50)),
        p85Days: round2(percentile(storyDays, 85)),
        excludedNoCreatedAt: resolved.length - withCreated.length,
      },
      traceability: {
        storiesWithCodePct: pct(storiesWithCode, items.length),
        prsWithStoryPct: pct(prsWithStory, prs.length),
        storiesTotal: items.length,
        prsTotal: prs.length,
      },
      review: await this.reviewMetrics(tenantId, merged),
    };
  }

  /**
   * Review Quality (METRICS.md §3) + the pr_cycle_time sub-phases.
   *
   * Scoped to MERGED PRs: an open PR hasn't finished waiting for review, so
   * counting it would report a coverage figure that improves purely because
   * work is still in flight.
   *
   * PRs whose reviews haven't been collected yet are excluded from every
   * percentage and reported as `excludedNoReviewData` — a PR with no review
   * ROW is indistinguishable from a genuinely unreviewed one, and silently
   * merging the two would report an alarming self-merge rate that is really
   * just incomplete collection. `firstReviewAt` is the discriminator: the
   * collector sets it (or explicitly null) only when it actually fetched the
   * reviews.
   */
  private async reviewMetrics(
    tenantId: string,
    merged: PullRequest[],
  ): Promise<EfficiencyView['review']> {
    const reviews = await this.code.listReviewsForPullRequests(
      tenantId,
      merged.map((pr) => ({
        repoFullName: pr.repoFullName,
        externalNumber: pr.externalNumber,
      })),
    );
    // Bots are excluded from every people metric below (METRICS.md §0). On a
    // real tenant an AI review bot was the 2nd-busiest "reviewer" at 15% of
    // all reviews, answering in seconds — left in, it flatters review coverage
    // AND drags review latency toward zero while no human has seen the change.
    const humanReviews = reviews.filter((r) => !r.isBot);
    const botReviews = reviews.length - humanReviews.length;

    const byPr = new Map<string, typeof reviews>();
    for (const r of humanReviews) {
      const key = `${r.repoFullName}#${r.externalNumber}`;
      byPr.set(key, [...(byPr.get(key) ?? []), r]);
    }
    const anyReviewByPr = new Set(
      reviews.map((r) => `${r.repoFullName}#${r.externalNumber}`),
    );

    // Collected = the review timeline was actually fetched for this PR,
    // including when the answer was "none". `reviewsFetchedAt` is the explicit
    // marker rather than an inference from absent rows, because "no reviews"
    // and "never asked" are the same absence and must not be conflated.
    const collected = merged.filter((pr) => pr.reviewsFetchedAt !== null);
    const prKey = (pr: PullRequest) =>
      `${pr.repoFullName}#${pr.externalNumber}`;
    // Reviewed = reviewed BY A HUMAN. `firstReviewAt` can't be used directly
    // any more: the collector derives it from all reviews including bots.
    const reviewed = collected.filter((pr) => byPr.has(prKey(pr)));
    const botOnlyReviewedPrs = collected.filter(
      (pr) => !byPr.has(prKey(pr)) && anyReviewByPr.has(prKey(pr)),
    ).length;

    /** Earliest human review on a PR — the honest first-review timestamp. */
    const firstHumanReviewAt = (pr: PullRequest): Date | undefined => {
      const rs = byPr.get(prKey(pr)) ?? [];
      return rs.length
        ? rs.reduce(
            (min, r) => (r.submittedAt < min ? r.submittedAt : min),
            rs[0].submittedAt,
          )
        : undefined;
    };
    const firstHumanApprovalAt = (pr: PullRequest): Date | undefined => {
      const rs = (byPr.get(prKey(pr)) ?? []).filter(
        (r) => r.state === 'approved',
      );
      return rs.length
        ? rs.reduce(
            (min, r) => (r.submittedAt < min ? r.submittedAt : min),
            rs[0].submittedAt,
          )
        : undefined;
    };

    const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;
    // All three phases run off HUMAN review timestamps. Using the stored
    // firstReviewAt/approvedAt would silently measure the bot: on a real
    // tenant that reported a 5-minute median time-to-first-review, which is a
    // bot's response time, not the team's.
    const ttfr = reviewed
      .filter((pr) => pr.openedAt)
      .map((pr) => hours(pr.openedAt!, firstHumanReviewAt(pr)!))
      .filter((h) => h >= 0)
      .sort((a, b) => a - b);
    const reviewTime = collected
      .map((pr) => ({
        first: firstHumanReviewAt(pr),
        approved: firstHumanApprovalAt(pr),
      }))
      .filter((x) => x.first && x.approved)
      .map((x) => hours(x.first!, x.approved!))
      .filter((h) => h >= 0)
      .sort((a, b) => a - b);
    const mergeTime = collected
      .map((pr) => ({
        approved: firstHumanApprovalAt(pr),
        merged: pr.mergedAt,
      }))
      .filter((x) => x.approved && x.merged)
      .map((x) => hours(x.approved!, x.merged!))
      .filter((h) => h >= 0)
      .sort((a, b) => a - b);

    // review_depth: inline comments per merged PR, human reviews only, and
    // only where the count actually ran.
    const depthPerPr = collected
      .map((pr) => (byPr.get(prKey(pr)) ?? []).filter((r) => r.commentsCounted))
      .filter((rs) => rs.length > 0)
      .map((rs) => rs.reduce((sum, r) => sum + r.commentCount, 0))
      .sort((a, b) => a - b);

    // rubber_stamp_rate: a LARGE PR approved by a human who left no inline
    // comment at all. Restricted to PRs whose comments were counted — an
    // uncounted zero is not evidence of anything.
    const rubberStampSample = collected.filter((pr) => {
      const size = (pr.additions ?? 0) + (pr.deletions ?? 0);
      if (size <= RUBBER_STAMP_SIZE_THRESHOLD) {
        return false;
      }
      const rs = byPr.get(prKey(pr)) ?? [];
      return rs.some((r) => r.state === 'approved' && r.commentsCounted);
    });
    const rubberStamped = rubberStampSample.filter((pr) => {
      const rs = (byPr.get(prKey(pr)) ?? []).filter((r) => r.commentsCounted);
      return rs.reduce((sum, r) => sum + r.commentCount, 0) === 0;
    });

    // Self-merge: merged by the author AND approved by nobody else. Both
    // halves matter — an author merging their own reviewed-and-approved PR is
    // normal practice, not a governance gap.
    //
    // Only PRs whose merger is known can answer this at all. `merged_by` comes
    // from the PR detail call, so a PR reconciled for reviews alone lacks it —
    // treating that as "not a self-merge" would dilute the rate toward zero,
    // so it gets its own denominator.
    const selfMergeSample = collected.filter(
      (pr) => pr.mergedBy && pr.authorLogin,
    );
    const selfMerged = selfMergeSample.filter((pr) => {
      if (pr.mergedBy !== pr.authorLogin) {
        return false;
      }
      const prReviews =
        byPr.get(`${pr.repoFullName}#${pr.externalNumber}`) ?? [];
      return !prReviews.some(
        (r) => r.state === 'approved' && r.reviewerLogin !== pr.authorLogin,
      );
    });

    // Reviewer load, excluding self-reviews so a team of one doesn't read as
    // perfectly distributed. Team-level distribution only — never a ranking.
    const authorByPr = new Map(
      merged.map((pr) => [
        `${pr.repoFullName}#${pr.externalNumber}`,
        pr.authorLogin,
      ]),
    );
    const perReviewer = new Map<string, number>();
    for (const r of humanReviews) {
      const author = authorByPr.get(`${r.repoFullName}#${r.externalNumber}`);
      if (!r.reviewerLogin || r.reviewerLogin === author) {
        continue;
      }
      perReviewer.set(
        r.reviewerLogin,
        (perReviewer.get(r.reviewerLogin) ?? 0) + 1,
      );
    }
    const loads = [...perReviewer.values()].sort((a, b) => b - a);
    const totalReviews = loads.reduce((a, b) => a + b, 0);

    return {
      mergedWithReviewPct: pct(reviewed.length, collected.length),
      mergedTotal: merged.length,
      excludedNoReviewData: merged.length - collected.length,
      timeToFirstReview: {
        sampleSize: ttfr.length,
        p50Hours: round2(percentile(ttfr, 50)),
        p85Hours: round2(percentile(ttfr, 85)),
      },
      reviewTime: {
        sampleSize: reviewTime.length,
        p50Hours: round2(percentile(reviewTime, 50)),
      },
      mergeTime: {
        sampleSize: mergeTime.length,
        p50Hours: round2(percentile(mergeTime, 50)),
      },
      selfMergedPct: pct(selfMerged.length, selfMergeSample.length),
      selfMergedCount: selfMerged.length,
      selfMergeSampleSize: selfMergeSample.length,
      reviewerCount: perReviewer.size,
      topReviewerSharePct: pct(loads[0] ?? 0, totalReviews),
      botReviews,
      botOnlyReviewedPrs,
      reviewDepth: {
        sampleSize: depthPerPr.length,
        p50Comments: round2(percentile(depthPerPr, 50)),
      },
      rubberStamp: {
        sampleSize: rubberStampSample.length,
        count: rubberStamped.length,
        pct: pct(rubberStamped.length, rubberStampSample.length),
        sizeThreshold: RUBBER_STAMP_SIZE_THRESHOLD,
      },
    };
  }

  /**
   * cycle_time / wip / wip_age / aging_work_items, all sourced from the
   * status-transition timeline rather than the current status.
   *
   * flow_efficiency and blocked_time are deliberately absent: they need
   * active-vs-waiting split WITHIN in-progress, and Jira's status category
   * can't provide it — "In Development" and "Blocked in QA" are both
   * `indeterminate`. That split needs a per-tenant status classification, so
   * guessing it here would produce a confident-looking number built on a
   * heuristic nobody agreed to.
   */
  async flowMetrics(
    projectKeys: string[],
    agingThresholdDays = 7,
  ): Promise<FlowMetricsView> {
    const tenantId = this.tenantContext.requireTenantId();
    const now = Date.now();

    // listFlowItems, not listWorkItems: the latter caps at 500 for table
    // display, which would silently compute these aggregates over a slice.
    const items = await this.planning.listFlowItems(tenantId, projectKeys);
    const flow = await this.planning.flowTimestamps(tenantId, projectKeys);

    const cycleDays: number[] = [];
    const wipAges: number[] = [];
    const aging: FlowMetricsView['aging']['items'] = [];
    let withHistory = 0;
    let excludedInstant = 0;

    for (const item of items) {
      const f = flow.get(item.externalKey);
      if (!f) {
        continue;
      }
      withHistory++;

      if (f.firstInProgressAt && f.firstDoneAt) {
        const seconds =
          (f.firstDoneAt.getTime() - f.firstInProgressAt.getTime()) / 1000;
        // Negative: marked done before work started (a status reshuffle can do
        // this) — noise either way, so it's grouped with the instant bucket.
        if (seconds < INSTANT_COMPLETION_SECONDS) {
          excludedInstant++;
        } else {
          cycleDays.push(seconds / 86_400);
        }
      }

      // Currently in progress: entered work, not yet done.
      const inProgress = Boolean(f.firstInProgressAt) && !f.firstDoneAt;
      if (inProgress && f.firstInProgressAt) {
        wipAges.push((now - f.firstInProgressAt.getTime()) / 86_400_000);
        const daysInStatus = f.currentStatusEnteredAt
          ? (now - f.currentStatusEnteredAt.getTime()) / 86_400_000
          : 0;
        if (daysInStatus > agingThresholdDays) {
          aging.push({
            externalKey: item.externalKey,
            projectKey: item.projectKey,
            status: item.status,
            daysInStatus: round2(daysInStatus) ?? 0,
          });
        }
      }
    }

    cycleDays.sort((a, b) => a - b);
    const agesSorted = [...wipAges].sort((a, b) => a - b);

    return {
      cycleTime: {
        sampleSize: cycleDays.length,
        p50Days: round2(percentile(cycleDays, 50)),
        p85Days: round2(percentile(cycleDays, 85)),
        excludedInstant,
        instantThresholdSeconds: INSTANT_COMPLETION_SECONDS,
      },
      wip: {
        count: wipAges.length,
        p50Days: round2(percentile(agesSorted, 50)),
        p85Days: round2(percentile(agesSorted, 85)),
        oldestDays: round2(
          agesSorted.length ? agesSorted[agesSorted.length - 1] : null,
        ),
      },
      aging: {
        thresholdDays: agingThresholdDays,
        count: aging.length,
        items: aging
          .sort((a, b) => b.daysInStatus - a.daysInStatus)
          .slice(0, 20),
      },
      coverage: {
        itemsInScope: items.length,
        itemsWithHistory: withHistory,
        coveragePct: pct(withHistory, items.length),
      },
    };
  }

  /**
   * Most-active projects for a window (day/week/month): commits + LOC across
   * every repo mapped to the project via the delivery graph. Repos linked to no
   * project are reported honestly in an "(unlinked repos)" bucket.
   */
  async projectActivity(from: Date, to?: Date): Promise<ProjectActivityView> {
    const tenantId = this.tenantContext.requireTenantId();
    const end = to ?? new Date();
    const repoToProjects = await this.repoToProjects(tenantId);
    const { commits, truncated } = await this.code.listCommitsPage(tenantId, {
      from,
      to: end,
    });
    const attribution = await this.identities.attributionCoverage(
      tenantId,
      from,
      end,
    );

    interface Acc {
      commits: number;
      additions: number;
      deletions: number;
      repoCommits: Map<string, number>;
      contributors: Set<string>;
      unattributed: number;
      byDay: Map<string, { commits: number; locChanged: number }>;
    }
    const acc = new Map<string, Acc>();
    const ensure = (key: string): Acc => {
      const cur =
        acc.get(key) ??
        ({
          commits: 0,
          additions: 0,
          deletions: 0,
          repoCommits: new Map(),
          contributors: new Set(),
          unattributed: 0,
          byDay: new Map(),
        } as Acc);
      acc.set(key, cur);
      return cur;
    };

    for (const c of commits) {
      const projects = repoToProjects.get(c.repoFullName) ?? [
        '(unlinked repos)',
      ];
      const day = istDateKey(c.committedAt ?? c.authoredAt);
      for (const project of projects) {
        const a = ensure(project);
        a.commits += 1;
        a.additions += c.additions;
        a.deletions += c.deletions;
        a.repoCommits.set(
          c.repoFullName,
          (a.repoCommits.get(c.repoFullName) ?? 0) + 1,
        );
        if (c.authorLogin) {
          a.contributors.add(c.authorLogin);
        } else {
          a.unattributed += 1;
        }
        const d = a.byDay.get(day) ?? { commits: 0, locChanged: 0 };
        d.commits += 1;
        d.locChanged += c.additions + c.deletions;
        a.byDay.set(day, d);
      }
    }

    const rows = [...acc.entries()]
      .map(([projectKey, a]) => ({
        projectKey,
        commits: a.commits,
        additions: a.additions,
        deletions: a.deletions,
        locChanged: a.additions + a.deletions,
        activeRepos: a.repoCommits.size,
        topRepo:
          [...a.repoCommits.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ??
          null,
        contributors: a.contributors.size,
        unattributedCommits: a.unattributed,
        dailySeries: [...a.byDay.entries()]
          .map(([date, d]) => ({
            date,
            commits: d.commits,
            locChanged: d.locChanged,
          }))
          .sort((x, y) => x.date.localeCompare(y.date)),
      }))
      .sort((x, y) => y.commits - x.commits || y.locChanged - x.locChanged);

    return { rows, attribution, truncated };
  }

  /** GitHub-style activity profile for one developer (activity context, not ranking). */
  async developerActivity(
    developer: string,
    from: Date,
    to?: Date,
  ): Promise<DeveloperActivityView> {
    const tenantId = this.tenantContext.requireTenantId();
    const end = to ?? new Date();
    // Resolve the person BEFORE querying: GitHub only attributes a commit when
    // its email is verified on an account, so filtering on the login alone
    // returns nothing for anyone whose git config uses an unverified address —
    // and the board then reports "0 commits" as a fact about them.
    const aliases = await this.identities.aliasesFor(tenantId, developer);
    const commits = await this.code.listCommits(tenantId, {
      authorLogins: aliases.logins,
      authorEmails: aliases.emails,
      from,
      to: end,
    });
    const prs = await this.code.listPullRequestsByAuthor(
      tenantId,
      aliases.logins,
      from,
      end,
    );

    const byRepo = new Map<
      string,
      { commits: number; loc: number; last: Date }
    >();
    const byDay = new Map<string, { commits: number; loc: number }>();
    let additions = 0;
    let deletions = 0;
    let filesChanged = 0;
    for (const c of commits) {
      const committedAt = c.committedAt ?? c.authoredAt;
      additions += c.additions;
      deletions += c.deletions;
      filesChanged += c.filesChanged;
      const r = byRepo.get(c.repoFullName) ?? {
        commits: 0,
        loc: 0,
        last: committedAt,
      };
      r.commits += 1;
      r.loc += c.additions + c.deletions;
      if (committedAt > r.last) r.last = committedAt;
      byRepo.set(c.repoFullName, r);

      const day = istDateKey(committedAt);
      const d = byDay.get(day) ?? { commits: 0, loc: 0 };
      d.commits += 1;
      d.loc += c.additions + c.deletions;
      byDay.set(day, d);
    }

    const repoToProjects = await this.repoToProjects(tenantId);
    const activeProjects = new Set<string>();
    for (const repo of byRepo.keys()) {
      for (const project of repoToProjects.get(repo) ?? []) {
        activeProjects.add(project);
      }
    }

    return {
      developer,
      totals: {
        commits: commits.length,
        additions,
        deletions,
        locChanged: additions + deletions,
        filesChanged,
        prsAuthored: prs.length,
        // Reported alongside `prsAuthored` because the two boards count
        // different things: this figure is what Delivery Explorer groups by
        // (merged only), while `prsAuthored` counts every PR opened in the
        // window whatever became of it. Showing both stops the gap between
        // them reading as a contradiction (DASHBOARDS.md §3).
        prsMerged: prs.filter((pr) => pr.mergedAt).length,
        activeRepos: byRepo.size,
      },
      identity: {
        logins: aliases.logins,
        recoveredEmails: aliases.emails,
        inferred: aliases.emails.length > 0,
      },
      activeProjects: [...activeProjects].sort(),
      byRepo: [...byRepo.entries()]
        .map(([repo, r]) => ({
          repo,
          commits: r.commits,
          locChanged: r.loc,
          lastCommitAt: r.last.toISOString(),
        }))
        .sort((a, b) => b.commits - a.commits),
      dailySeries: [...byDay.entries()]
        .map(([date, d]) => ({ date, commits: d.commits, locChanged: d.loc }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      recentCommits: commits.slice(0, 20).map((c) => ({
        sha: c.sha.slice(0, 7),
        repo: c.repoFullName,
        message: c.message.split('\n')[0],
        authoredAt: c.authoredAt.toISOString(),
        committedAt: (c.committedAt ?? c.authoredAt).toISOString(),
        additions: c.additions,
        deletions: c.deletions,
      })),
    };
  }

  /** repo → project keys via the delivery graph (cached per call, N≤60 projects). */
  private async repoToProjects(
    tenantId: string,
  ): Promise<Map<string, string[]>> {
    const projects = await this.planning.listProjectKeys(tenantId);
    const map = new Map<string, string[]>();
    for (const project of projects) {
      const repos = await this.correlation.reposLinkedToProjects(tenantId, [
        project,
      ]);
      for (const repo of repos) {
        map.set(repo, [...(map.get(repo) ?? []), project]);
      }
    }
    return map;
  }

  // ---- helpers -------------------------------------------------------------

  private async findSprint(
    tenantId: string,
    externalId: string,
  ): Promise<Sprint | null> {
    const sprints = await this.planning.listSprints(tenantId);
    return sprints.find((s) => s.externalId === externalId) ?? null;
  }

  private async toViews(
    tenantId: string,
    items: Story[],
  ): Promise<WorkItemView[]> {
    const linkByStory = await this.correlation.prRefsByStoryId(
      tenantId,
      items.map((i) => i.id),
    );
    const allRefs = [...new Set([...linkByStory.values()].flat())];
    const prs = await this.code.listPullRequestsByRefs(tenantId, allRefs);
    const prByRef = new Map<string, PullRequest>(
      prs.map((pr) => [
        `${pr.repoFullName}#${pr.externalNumber}`.toLowerCase(),
        pr,
      ]),
    );
    return items.map((i) => ({
      key: i.externalKey,
      title: i.title,
      type: i.type,
      status: i.status,
      done: isDone(i),
      storyPoints: i.storyPoints,
      assigneeName: i.assigneeName,
      epicKey: i.epicKey,
      parentKey: i.parentKey,
      sprintExternalId: i.sprintExternalId,
      releases: i.releases,
      resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
      linkedPrs: (linkByStory.get(i.id) ?? []).map((ref) => ({
        ref,
        state: prByRef.get(ref.toLowerCase())?.state ?? null,
      })),
    }));
  }

  private async avgSprintDays(
    tenantId: string,
    projectKey: string,
  ): Promise<number> {
    const closed = await this.planning.listSprints(
      tenantId,
      [projectKey],
      'closed',
    );
    const spans = closed
      .filter((s) => s.startAt && s.endAt)
      .map((s) => (s.endAt!.getTime() - s.startAt!.getTime()) / 86_400_000)
      .filter((d) => d > 0);
    if (spans.length === 0) {
      return DEFAULT_SPRINT_DAYS;
    }
    return Math.round(spans.reduce((a, b) => a + b, 0) / spans.length);
  }
}

function isDone(item: { status: string }): boolean {
  return DONE_STATUSES.includes(item.status);
}

function sumPoints(views: WorkItemView[]): number {
  return views.reduce((s, v) => s + (v.storyPoints ?? 0), 0);
}

function sumStoryPoints(items: Story[]): number {
  return items.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
}

/** Newest sprint end in a group — used to float recently-active projects up. */
function latestEnd(rows: VelocityRow[]): number | null {
  const ends = rows
    .map((r) => (r.sprint.endAt ? Date.parse(r.sprint.endAt) : null))
    .filter((t): t is number => t !== null);
  return ends.length > 0 ? Math.max(...ends) : null;
}

/**
 * Project-level averages, over CLOSED sprints only.
 *
 * The in-flight sprint is deliberately excluded: it has completed a fraction of
 * its work because it is a fraction of the way through, and averaging that
 * against finished sprints drags the mean down by an amount that depends
 * entirely on what day you happen to load the page.
 */
function summarizeVelocity(
  projectKey: string,
  rows: VelocityRow[],
): ProjectVelocity {
  // Two exclusions, both about not averaging a number that isn't one:
  // an in-progress sprint is partial by definition, and a sprint that closed
  // before the collection floor holds only the few items touched since.
  const closed = rows.filter((r) => !r.inProgress && !r.beyondHorizon);
  // A sprint where nothing was estimated has no velocity — not a velocity of
  // zero. Averaging those in would report a team as slowing down when all that
  // changed is that they stopped estimating. Same predicate as `forecast`, so
  // the two boards can't quote different averages for the same project.
  const measurable = closed.filter((r) => r.committedPoints > 0);
  const mean = (values: number[]): number | null =>
    values.length > 0
      ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1))
      : null;

  const itemsTotal = closed.reduce((s, r) => s + r.itemsTotal, 0);
  const estimated = closed.reduce(
    (s, r) => s + (r.itemsTotal - r.unestimatedItems),
    0,
  );
  const coverage = pct(estimated, itemsTotal);

  return {
    projectKey,
    rows,
    avgCompletedPoints: mean(measurable.map((r) => r.completedPoints)),
    avgCompletedItems: mean(closed.map((r) => r.itemsDone)),
    closedSprintsSampled: closed.length,
    sprintsBeyondHorizon: rows.filter((r) => r.beyondHorizon).length,
    estimateCoveragePct: coverage,
    pointsReliable: coverage !== null && coverage >= MIN_ESTIMATE_COVERAGE_PCT,
  };
}

function toStaleSprint(sprint: Sprint): StaleSprint {
  return {
    sprint: toSprintSummary(sprint),
    daysPastEnd: sprint.endAt
      ? Math.floor((Date.now() - sprint.endAt.getTime()) / 86_400_000)
      : 0,
  };
}

function toSprintSummary(sprint: Sprint): SprintSummary {
  return {
    externalId: sprint.externalId,
    name: sprint.name,
    state: sprint.state,
    projectKey: sprint.projectKey,
    startAt: sprint.startAt ? sprint.startAt.toISOString() : null,
    endAt: sprint.endAt ? sprint.endAt.toISOString() : null,
  };
}

function meanOf(values: number[]): number | null {
  return values.length > 0
    ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1))
    : null;
}

function pct(part: number, total: number): number | null {
  return total > 0 ? Number(((part / total) * 100).toFixed(1)) : null;
}

/** How far through its OWN window this sprint is (normalizes cadences). */
function sprintElapsedPct(sprint: Sprint): number | null {
  if (!sprint.startAt || !sprint.endAt || sprint.endAt <= sprint.startAt) {
    return null;
  }
  const span = sprint.endAt.getTime() - sprint.startAt.getTime();
  const elapsed = Date.now() - sprint.startAt.getTime();
  return Number(Math.min(100, Math.max(0, (elapsed / span) * 100)).toFixed(1));
}

/** Pace = completion vs elapsed; ≤10pt gap on-track, ≤30 at-risk, else behind. */
function paceOf(
  state: string,
  completionPct: number | null,
  elapsedPct: number | null,
): SprintPace {
  if (state !== 'active' || completionPct === null || elapsedPct === null) {
    return 'unknown';
  }
  const gap = elapsedPct - completionPct;
  if (gap <= 10) {
    return 'on-track';
  }
  return gap <= 30 ? 'at-risk' : 'behind';
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) {
    return null;
  }
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.min(Math.max(idx, 0), sortedAsc.length - 1)];
}

function round2(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(2));
}
