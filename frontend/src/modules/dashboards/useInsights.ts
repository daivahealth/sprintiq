import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api/client';
import type { Scope } from '../../lib/scope';
import { rangeParams, type ActivityRange } from './activity-range';

// ---- Response types (mirror backend insights.service.ts) -------------------

export interface DashboardAssignment {
  key: string;
  title: string;
  path: string;
  description: string;
  /**
   * Subsections rendered as nested nav under this entry. Optional: an API
   * deployed before the Developer Activity section existed sends no such
   * field, and the nav must render exactly as it did then.
   */
  children?: {
    key: string;
    title: string;
    path: string;
    description: string;
  }[];
}

export interface LinkedPr {
  ref: string;
  state: string | null;
}

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
  linkedPrs: LinkedPr[];
}

export interface SprintSummary {
  externalId: string;
  name: string;
  state: string;
  projectKey: string;
  startAt: string | null;
  endAt: string | null;
}

export type SprintPace = 'on-track' | 'at-risk' | 'behind' | 'unknown';

export interface SprintHealthView {
  sprint: SprintSummary;
  committedPoints: number;
  completedPoints: number;
  completionPct: number | null;
  /** How far through its OWN window the sprint is — normalizes cadences. */
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
  /** Items with no estimate — invisible to both points figures. */
  unestimatedItems: number;
  estimateCoveragePct: number | null;
  /** Still running: partial by definition, never averaged in. */
  inProgress: boolean;
  elapsedPct: number | null;
  /** Closed before the collection floor — only partly collected, never averaged. */
  beyondHorizon?: boolean;
}

/** Velocity for one project — the only scope at which it's comparable. */
export interface ProjectVelocity {
  projectKey: string;
  /** Current → past; the running sprint first. */
  rows: VelocityRow[];
  avgCompletedPoints: number | null;
  avgCompletedItems: number | null;
  closedSprintsSampled: number;
  /** Sprints shown but excluded from averages — they predate the collected data. */
  sprintsBeyondHorizon?: number;
  estimateCoveragePct: number | null;
  /** False when too little is estimated for points to describe the sprint. */
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
  /** The same projection on item counts — the one that survives low estimate coverage. */
  avgVelocityItems: number | null;
  sprintsNeededByItems: number | null;
  projectedDateByItems: string | null;
  estimateCoveragePct: number | null;
  /** False when too little is estimated for the points projection to mean anything. */
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
  prCycle: { sampleSize: number; p50Hours: number | null; p85Hours: number | null };
  storyCycle: {
    sampleSize: number;
    p50Days: number | null;
    p85Days: number | null;
    /** Resolved items with no Jira creation date — lead time is unmeasurable for them. */
    excludedNoCreatedAt: number;
  };
  traceability: {
    storiesWithCodePct: number | null;
    prsWithStoryPct: number | null;
    storiesTotal: number;
    prsTotal: number;
  };
  /** Review Quality + pr_cycle_time sub-phases, from the collected review timeline. */
  review: {
    mergedWithReviewPct: number | null;
    mergedTotal: number;
    /** Merged PRs whose reviews aren't collected yet — excluded from the percentages. */
    excludedNoReviewData: number;
    timeToFirstReview: {
      sampleSize: number;
      p50Hours: number | null;
      p85Hours: number | null;
    };
    reviewTime: { sampleSize: number; p50Hours: number | null };
    mergeTime: { sampleSize: number; p50Hours: number | null };
    selfMergedPct: number | null;
    selfMergedCount: number;
    /** PRs where the merger is known — the self-merge denominator. */
    selfMergeSampleSize: number;
    reviewerCount: number;
    topReviewerSharePct: number | null;
    /** Automated reviews, excluded from every figure above. */
    botReviews: number;
    /** Merged PRs whose only review was a bot — reviewed on paper, not in practice. */
    botOnlyReviewedPrs: number;
    reviewDepth: { sampleSize: number; p50Comments: number | null };
    rubberStamp: {
      sampleSize: number;
      count: number;
      pct: number | null;
      sizeThreshold: number;
    };
  };
  computedAt: string;
}

/**
 * Flow metrics from the status-transition timeline. Distinct from
 * `EfficiencyView.storyCycle`, which measures resolved−(Jira) created (lead
 * time) and so counts backlog waiting as if it were work.
 */
export interface FlowMetricsView {
  cycleTime: {
    sampleSize: number;
    p50Days: number | null;
    p85Days: number | null;
    /** Completions inside the threshold — workflow click-through, not delivery. */
    excludedInstant: number;
    instantThresholdSeconds: number;
  };
  wip: {
    count: number;
    p50Days: number | null;
    p85Days: number | null;
    oldestDays: number | null;
  };
  aging: {
    thresholdDays: number;
    count: number;
    items: {
      externalKey: string;
      projectKey: string;
      status: string;
      daysInStatus: number;
    }[];
  };
  coverage: {
    itemsInScope: number;
    itemsWithHistory: number;
    coveragePct: number | null;
  };
  computedAt: string;
}

export interface SprintCatalogItem extends SprintSummary {}

export type ActivityWindow = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface ProjectActivityRow {
  projectKey: string;
  commits: number;
  locChanged: number;
  additions: number;
  deletions: number;
  activeRepos: number;
  topRepo: string | null;
  contributors: number;
  /**
   * Commits counted in the totals but attributable to no developer.
   * Optional: the frontend and backend deploy separately, so a build of this
   * app can be live against an API that predates the field. Absent means
   * "this API can't tell us", which must render as unknown — never as zero.
   */
  unattributedCommits?: number;
  /** Per-day activity (sparse: only days with commits). */
  dailySeries: { date: string; commits: number; locChanged: number }[];
}

/**
 * How much of a window's commit volume can be attributed to a person at all.
 * GitHub resolves a commit's account only when its email is verified there, so
 * this is routinely below 100% and the boards must say so rather than let
 * "0 commits" read as "did nothing".
 */
export interface AttributionCoverage {
  commitsInScope: number;
  commitsAttributed: number;
  commitsUnattributed: number;
  coveragePct: number | null;
  unattributedIdentities: number;
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
    /** Of those, the ones merged — what Delivery Explorer counts. Optional: see `identity`. */
    prsMerged?: number;
    activeRepos: number;
  };
  /**
   * The source identities these figures were gathered under. Optional for the
   * same reason as `ProjectActivityRow.unattributedCommits` — this build can be
   * serving against an API deployed before identity resolution existed, and
   * dereferencing it unguarded took the whole board down.
   */
  identity?: {
    logins: string[];
    recoveredEmails: string[];
    inferred: boolean;
  };
  activeProjects: string[];
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
    committedAt: string;
    additions: number;
    deletions: number;
  }[];
  /**
   * Non-bot reviews this person submitted in the window. Optional for the same
   * frontend/backend-skew reason as `identity`: a build of this app can be
   * serving against an API deployed before the section existed.
   */
  prsReviewed?: number;
  /**
   * Their assigned Jira work. `null` means the assignee bridge never matched
   * this person — which the page must SAY, because an empty list rendered
   * without that caveat asserts they have nothing assigned.
   */
  assignment?: {
    openItems: {
      key: string;
      projectKey: string;
      type: string;
      status: string;
      title: string;
      inSprint: boolean;
    }[];
    jiraRefs: string[];
  } | null;
  assigneeCoverage?: JiraAssigneeCoverage;
}

/**
 * Team-level daily commit log: who committed each day, with counts. Activity
 * context, not a ranking — developers arrive alphabetical per day; the
 * count-sort is an explicit toggle in the section, never the default.
 */
export interface DailyDeveloperActivityView {
  /** Newest day first. */
  days: {
    date: string;
    totalCommits: number;
    developers: { developer: string; displayName: string; commits: number }[];
    /** Commits matching no known identity — disclosed, never dropped. */
    unattributedCommits: number;
  }[];
  totals: { commits: number; activeDevelopers: number };
  /** The read hit its ceiling — figures under-report the window and say so. */
  truncated: boolean;
  /**
   * Days the server actually measured, which is not always what was asked for
   * — an unrecognised window falls back to 30 so a frontend can ship ahead of
   * its backend. Optional because an older backend won't send it. Render the
   * interval from this, not from the selected window, or a skewed deploy
   * labels 30 days of data with a 90-day heading.
   */
  windowDays?: number;
}

// ---- Hooks ------------------------------------------------------------------

function scopeParams(scope: Scope, from?: string): URLSearchParams {
  const params = new URLSearchParams();
  if (scope.projects.length > 0) params.set('projects', scope.projects.join(','));
  if (scope.repos.length > 0) params.set('repos', scope.repos.join(','));
  if (from) params.set('from', from);
  return params;
}

/**
 * How current the collected data is (METRICS.md §9). Deliberately separate
 * from each view's `computedAt`, which only says when the QUERY ran — with
 * polling on a 4-hour default interval, "computed just now" over four-hour-old
 * facts is the misreading this exists to prevent.
 */
export interface FreshnessView {
  /**
   * Source time everything on screen is COMPLETE through — the real bound.
   * Null while any connection is still backfilling (`incomplete`).
   */
  collectedThroughAt: string | null;
  /**
   * Oldest point collected back to. A board's window `[from, now]` is complete
   * iff `collectedBackTo <= from` — which is how a "last 7 days" board can be
   * complete while a 12-month backfill is still walking.
   */
  collectedBackTo: string | null;
  behindSeconds: number | null;
  /** Active connections still backfilling — complete through nothing yet. */
  incomplete: number;
  /**
   * Oldest time we last REACHED a source. Not a completeness measure: a
   * connection can poll every 5 minutes while far behind in its backfill.
   * Kept to distinguish "running and behind" from "stopped".
   */
  lastSyncAt: string | null;
  staleSeconds: number | null;
  neverSynced: number;
  failing: { sourceSystem: string; name: string; error: string }[];
  sources: {
    sourceSystem: string;
    lastSyncAt: string | null;
    collectedThroughAt: string | null;
  }[];
}

export function useFreshness() {
  return useQuery({
    queryKey: ['freshness'],
    queryFn: () => api.get<FreshnessView>('/api/dashboards/freshness'),
    // Re-checked on an interval: staleness grows on its own, without any
    // user action to invalidate the cache.
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

export function useAssignments() {
  return useQuery({
    queryKey: ['assignments'],
    queryFn: () =>
      api.get<{ dashboards: DashboardAssignment[] }>(
        '/api/dashboards/assignments',
      ),
    staleTime: 5 * 60_000,
  });
}

/**
 * Sprints for the picker.
 *
 * `states` defaults to active + closed. An unstarted sprint has no dates, no
 * transitions and nothing delivered, so every figure the sprint boards compute
 * is empty for it — listing it alongside real sprints only invites picking one
 * and seeing a blank board.
 */
export function useSprintCatalog(projects: string[], states = 'active,closed') {
  const params = new URLSearchParams();
  if (projects.length > 0) params.set('projects', projects.join(','));
  if (states) params.set('state', states);
  return useQuery({
    queryKey: ['catalog', 'sprints', projects.join(','), states],
    queryFn: () =>
      api.get<{ items: SprintCatalogItem[] }>(`/api/catalog/sprints?${params}`),
    staleTime: 60_000,
  });
}

/**
 * A sprint Jira still labels active whose end date is long past. Reported
 * separately from the live ones: it is 100% elapsed by definition, so ranking
 * it by pace always floats it above the sprint that actually needs attention.
 */
export interface StaleSprint {
  sprint: SprintSummary;
  daysPastEnd: number;
}

/** All concurrent active sprints in scope (one per project lifecycle). */
export function useActiveSprintsHealth(projects: string[]) {
  const params = new URLSearchParams();
  if (projects.length > 0) params.set('projects', projects.join(','));
  return useQuery({
    queryKey: ['sprint-health-active', projects.join(',')],
    queryFn: () =>
      api.get<{
        rows: SprintHealthView[];
        stale?: StaleSprint[];
        staleGraceDays?: number;
        computedAt: string;
      }>(`/api/dashboards/sprint-health/active?${params}`),
  });
}

export function useSprintHealth(sprint: string | null) {
  return useQuery({
    queryKey: ['sprint-health', sprint],
    queryFn: () =>
      api.get<SprintHealthView>(`/api/dashboards/sprint-health?sprint=${sprint}`),
    enabled: Boolean(sprint),
  });
}

/** Risk across all concurrent active sprints in scope, worst-first. */
export function useActiveSprintsRisk(projects: string[]) {
  const params = new URLSearchParams();
  if (projects.length > 0) params.set('projects', projects.join(','));
  return useQuery({
    queryKey: ['sprint-risk-active', projects.join(',')],
    queryFn: () =>
      api.get<{
        rows: SprintRiskView[];
        stale?: StaleSprint[];
        staleGraceDays?: number;
        computedAt: string;
      }>(`/api/dashboards/sprint-risk/active?${params}`),
  });
}

export function useSprintRisk(sprint: string | null) {
  return useQuery({
    queryKey: ['sprint-risk', sprint],
    queryFn: () =>
      api.get<SprintRiskView>(`/api/dashboards/sprint-risk?sprint=${sprint}`),
    enabled: Boolean(sprint),
  });
}

export function useVelocity(projects: string[]) {
  const params = new URLSearchParams();
  if (projects.length > 0) params.set('projects', projects.join(','));
  return useQuery({
    queryKey: ['velocity', projects.join(',')],
    queryFn: () =>
      api.get<{ groups: ProjectVelocity[]; computedAt: string }>(
        `/api/dashboards/velocity?${params}`,
      ),
  });
}

export function useForecast(projects: string[]) {
  const params = new URLSearchParams();
  if (projects.length > 0) params.set('projects', projects.join(','));
  return useQuery({
    queryKey: ['forecast', projects.join(',')],
    queryFn: () =>
      api.get<{ rows: ForecastView[]; computedAt: string }>(
        `/api/dashboards/forecast?${params}`,
      ),
  });
}

export function useProductivity(scope: Scope, from: string) {
  const params = scopeParams(scope, from);
  return useQuery({
    queryKey: ['productivity', params.toString()],
    queryFn: () =>
      api.get<{ weeks: ProductivityWeek[]; computedAt: string }>(
        `/api/dashboards/productivity?${params}`,
      ),
  });
}

export function useEfficiency(scope: Scope, from: string) {
  const params = scopeParams(scope, from);
  return useQuery({
    queryKey: ['efficiency', params.toString()],
    queryFn: () =>
      api.get<EfficiencyView>(`/api/dashboards/efficiency?${params}`),
  });
}

export function useFlowMetrics(projects: string[], agingDays = 7) {
  const params = new URLSearchParams();
  if (projects.length) params.set('projects', projects.join(','));
  params.set('agingDays', String(agingDays));
  return useQuery({
    queryKey: ['flow', params.toString()],
    queryFn: () => api.get<FlowMetricsView>(`/api/dashboards/flow?${params}`),
  });
}

export function useProjectActivity(window: ActivityWindow) {
  return useQuery({
    queryKey: ['project-activity', window],
    queryFn: () =>
      api.get<{
        window: string;
        rows: ProjectActivityRow[];
        attribution: AttributionCoverage;
        /** The commit read hit its ceiling — totals cover only part of the window. */
        truncated?: boolean;
        computedAt: string;
      }>(`/api/dashboards/project-activity?window=${window}`),
  });
}

/**
 * Canonical developers. `login` is the identity to query by; `displayName` is
 * what to show — they differ for people no GitHub account was matched to, who
 * the old login-only catalog could not list at all.
 */
export interface DeveloperCatalogItem {
  login: string;
  /** Optional: an API predating identity resolution returns `login` only. */
  displayName?: string;
  attributed?: boolean;
  /** Newest commit across all of this person's identities — drives auto-select. */
  lastActiveAt?: string | null;
}

export function useDeveloperCatalog(search: string) {
  return useQuery({
    queryKey: ['catalog', 'developers', search],
    queryFn: () =>
      api.get<{ items: DeveloperCatalogItem[] }>(
        `/api/catalog/developers${search ? `?search=${encodeURIComponent(search)}` : ''}`,
      ),
    staleTime: 60_000,
  });
}

export function useDeveloperActivity(
  developer: string | null,
  range: ActivityRange,
) {
  const params = rangeParams(range);
  params.set('developer', developer ?? '');
  return useQuery({
    queryKey: ['developer-activity', params.toString()],
    queryFn: () =>
      api.get<DeveloperActivityView & { computedAt: string }>(
        `/api/dashboards/developer-activity?${params}`,
      ),
    enabled: Boolean(developer),
  });
}

export function useDailyDeveloperActivity(window: ActivityWindow) {
  return useQuery({
    queryKey: ['developer-activity-daily', window],
    queryFn: () =>
      api.get<DailyDeveloperActivityView & { computedAt: string }>(
        `/api/dashboards/developer-activity/daily?window=${window}`,
      ),
    staleTime: 60_000,
  });
}

// ---- Developer Activity section (DASHBOARDS.md §4.4) -----------------------

/**
 * How far the Jira↔GitHub assignee bridge reaches.
 *
 * Rendered wherever assignment is, and for the same reason `AttributionCoverage`
 * is rendered beside commit counts: an assignee the bridge never matched and a
 * developer with nothing assigned are the same absence on screen and opposite
 * findings in fact. A page that shows the second without the first is asserting
 * something it cannot support.
 */
export interface JiraAssigneeCoverage {
  /** Developers who committed in the window, automation excluded. */
  developersInWindow: number;
  /** Of those, the ones linked to a Jira account. */
  developersLinked: number;
  /**
   * developersLinked / developersInWindow — the figure to show.
   *
   * NOT the assignee-side ratio below. That one reads as "how well the bridge
   * works" and is nothing of the kind: most Jira assignees are QA, BA and
   * support staff who never commit, so it measures org composition. Showing it
   * as the trust signal understated the bridge by half on the reference tenant
   * (41% against a real 90%) and pointed remediation at the wrong problem.
   */
  coveragePct: number | null;
  /** Active committers with no Jira account — the actionable list. */
  unlinkedDevelopers: string[];
  /** Org context only. Never the headline. */
  assigneesObserved: number;
  assigneesMatched: number;
  assigneesUnmatched: number;
}

export interface ActivityDay {
  date: string;
  totalCommits: number;
  developers: { developer: string; displayName: string; commits: number }[];
  unattributedCommits: number;
}

/** One person's tracked signals in the window. Context, never a score. */
export interface ActiveDeveloper {
  /** Canonical developer id — what `?developer=` resolves against. */
  developer: string;
  displayName: string;
  commits: number;
  prsOpened: number;
  prsMerged: number;
}

export interface DeveloperOverviewView {
  totals: {
    commits: number;
    developersWithSignal: number;
    developersKnown: number;
    prsOpened: number;
    prsMerged: number;
    /** Null when the bridge matched nobody — never render null as zero. */
    committingWithoutAssignedWork: number | null;
  };
  /**
   * Everyone with a signal in the window, alphabetical from the API. Exactly
   * the set `totals.developersWithSignal` counts, so the roster and the tile
   * cannot disagree about the same window.
   */
  activeDevelopers: ActiveDeveloper[];
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

export type SignalType = 'commit' | 'pr_opened' | 'pr_merged' | 'pr_reviewed';
export type WatchlistBucket = 'active' | 'quiet' | 'no_signal';

export interface WatchlistDeveloper {
  developer: string;
  displayName: string;
  projects: string[];
  lastSignal: { type: SignalType; at: string } | null;
  bucket: WatchlistBucket;
  /** `null` = the bridge never matched them. Not the same as "nothing assigned". */
  hasAssignedWork: boolean | null;
  assignedOpenItems?: number;
}

/** A possible identity match, shown for a person to read — never applied. */
export interface MatchSuggestion {
  candidate: string;
  candidateName: string;
  /** `token_subset` is stronger evidence than `substring`. */
  basis: 'token_subset' | 'substring';
}

export interface WatchlistView {
  developers: WatchlistDeveloper[];
  counts: Record<WatchlistBucket, number>;
  committingWithoutAssignedWork: WatchlistDeveloper[];
  excluded: {
    developer: string;
    displayName: string;
    reason: string;
    expiresAt: string;
  }[];
  /**
   * Committers nothing linked automatically, each with the names that might be
   * them. Optional: an API deployed before this shipped sends no such field.
   */
  unlinked?: {
    developer: string;
    displayName: string;
    suggestions: MatchSuggestion[];
  }[];
  /**
   * Accounts GitHub anonymized on deprovision. Reported but never bucketed —
   * "no tracked activity" against a decommissioned account would invite
   * someone to go check on a person who has left.
   */
  inactiveAccounts?: {
    developer: string;
    prsAuthored: number;
    lastSignal: { type: SignalType; at: string } | null;
  }[];
  assigneeCoverage: JiraAssigneeCoverage;
  thresholds: {
    activeWithinWorkingDays: number;
    quietWithinWorkingDays: number;
  };
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
  neverReviewed: boolean;
}

export interface PrStatusView {
  totals: {
    open: number;
    waitingOverThreshold: number;
    neverReviewed: number;
    reviewsGiven: number;
    botReviews: number;
  };
  waiting: WaitingPr[];
  reviewLoad: {
    developer: string;
    displayName: string;
    prsRaised: number;
    prsReviewed: number;
    oldestWaitingHours: number | null;
  }[];
  /** Open PRs whose review timeline was never fetched — not "unreviewed". */
  excludedNoReviewData: number;
  thresholdHours: number;
  windowDays: number;
  computedAt: string;
}

export function useDeveloperOverview(range: ActivityRange) {
  const params = rangeParams(range);
  return useQuery({
    queryKey: ['developer-activity-overview', params.toString()],
    queryFn: () =>
      api.get<DeveloperOverviewView>(
        `/api/dashboards/developer-activity/overview?${params}`,
      ),
    staleTime: 60_000,
  });
}

export function useWatchlist(range: ActivityRange) {
  const params = rangeParams(range);
  return useQuery({
    queryKey: ['developer-activity-watchlist', params.toString()],
    queryFn: () =>
      api.get<WatchlistView>(
        `/api/dashboards/developer-activity/watchlist?${params}`,
      ),
    staleTime: 60_000,
  });
}

export function usePrStatus(range: ActivityRange) {
  const params = rangeParams(range);
  return useQuery({
    queryKey: ['developer-activity-pr-status', params.toString()],
    queryFn: () =>
      api.get<PrStatusView>(
        `/api/dashboards/developer-activity/pr-status?${params}`,
      ),
    staleTime: 60_000,
  });
}

export function useWorkItems(filters: {
  projects?: string[];
  types?: string[];
  sprint?: string;
  epic?: string;
  release?: string;
}) {
  const params = new URLSearchParams();
  if (filters.projects?.length) params.set('projects', filters.projects.join(','));
  if (filters.types?.length) params.set('types', filters.types.join(','));
  if (filters.sprint) params.set('sprint', filters.sprint);
  if (filters.epic) params.set('epic', filters.epic);
  if (filters.release) params.set('release', filters.release);
  return useQuery({
    queryKey: ['work-items', params.toString()],
    queryFn: () =>
      api.get<{ items: WorkItemView[]; computedAt: string }>(
        `/api/dashboards/work-items?${params}`,
      ),
  });
}
