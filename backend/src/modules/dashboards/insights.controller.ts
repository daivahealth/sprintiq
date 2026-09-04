import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { istWindowFloor } from '../../common/time';
import { CorrelationService } from '../../correlation/correlation.service';
import { DeveloperActivityService } from '../../metrics/developer-activity.service';
import { InsightsService } from '../../metrics/insights.service';
import { CodeService } from '../code/code.service';
import { ConnectionsService } from '../connections/connections.service';
import { ACTIVITY_WINDOWS, resolveActivityRange } from './activity-range';
import { parseList } from './catalog.controller';

const ALL_ROLES = Object.values(Role);

/**
 * The COMMON dashboards (not persona pages): every dashboard is metric-centric
 * and assignable to roles. Defaults below give all roles everything; per-tenant
 * assignment overrides are an admin feature on the roadmap (DASHBOARDS.md).
 */
export const DASHBOARD_REGISTRY: {
  key: string;
  title: string;
  path: string;
  description: string;
  roles: Role[];
  /**
   * Subsections of one dashboard, rendered as nested nav under the parent.
   *
   * Only Engineering Activity has these today. They are children rather than
   * four peer entries because they share one window, one dataset and one
   * purpose — listing them flat would read as four boards and grow the
   * sidebar by four permanent items (DASHBOARDS.md §4.4).
   */
  children?: {
    key: string;
    title: string;
    path: string;
    description: string;
  }[];
}[] = [
  // First in the nav (moved 2026-09-04). This array's order IS the sidebar
  // order — `/assignments` filters by role and hands it over unchanged — so
  // position here is a product decision, not a listing detail.
  //
  // Renamed from "Developer Activity" on 2026-08-31. The `key`s deliberately
  // keep the old name: they are role-assignment identifiers, not display text,
  // and rewriting them would silently drop any per-tenant assignment override
  // stored against them. Only `title` and `path` are user-facing.
  {
    key: 'developer-activity',
    title: 'Engineering Activity',
    path: '/engineering-activity/overview',
    description:
      'Team activity, the watchlist, one developer’s profile, and the review queue.',
    roles: ALL_ROLES,
    children: [
      {
        key: 'developer-activity-overview',
        title: 'Overview',
        path: '/engineering-activity/overview',
        description:
          'Team-shaped totals, the daily commit series, and data-health coverage.',
      },
      {
        key: 'developer-activity-watchlist',
        title: 'Watchlist',
        path: '/engineering-activity/watchlist',
        description:
          'Who has shown no tracked signal lately, and who is committing outside the plan. A prompt to ask, not a verdict.',
      },
      {
        key: 'developer-activity-developer',
        title: 'Developer',
        path: '/engineering-activity/developer',
        description:
          'One developer’s commits, repos, PRs and assigned work — activity context, never a ranking.',
      },
      {
        key: 'developer-activity-pr-status',
        title: 'PR Status',
        path: '/engineering-activity/pr-status',
        description:
          'Pull requests waiting on review and how review load is spread.',
      },
    ],
  },
  {
    key: 'delivery',
    title: 'Delivery Explorer',
    path: '/',
    description: 'Any metric × scope × grouping over the delivery graph.',
    roles: ALL_ROLES,
  },
  {
    key: 'sprint-health',
    title: 'Sprint Health',
    path: '/sprint-health',
    description: 'Committed vs completed, linkage coverage, by-type progress.',
    roles: ALL_ROLES,
  },
  {
    key: 'sprint-risk',
    title: 'Sprint Risk',
    path: '/sprint-risk',
    description: 'Open items without code, open bugs, unestimated work.',
    roles: ALL_ROLES,
  },
  {
    key: 'velocity',
    title: 'Velocity',
    path: '/velocity',
    description: 'Completed vs committed points per closed sprint.',
    roles: ALL_ROLES,
  },
  {
    key: 'forecast',
    title: 'Forecasting',
    path: '/forecast',
    description: 'Average velocity vs remaining backlog → projected finish.',
    roles: ALL_ROLES,
  },
  {
    key: 'productivity',
    title: 'Productivity',
    path: '/productivity',
    description: 'Weekly throughput: items, points, merged PRs, changed LOC.',
    roles: ALL_ROLES,
  },
  {
    key: 'efficiency',
    title: 'Efficiency',
    path: '/efficiency',
    description: 'PR + story cycle times and Jira↔GitHub traceability.',
    roles: ALL_ROLES,
  },
  {
    key: 'flow',
    title: 'Flow',
    path: '/flow',
    description:
      'Cycle time, WIP and ageing from the status-transition timeline.',
    roles: ALL_ROLES,
  },
  {
    key: 'project-activity',
    title: 'Project Activity',
    path: '/project-activity',
    description:
      'Most-active projects (commits + LOC across mapped repos) by day/week/month.',
    roles: ALL_ROLES,
  },
  {
    key: 'top-repos',
    title: 'Top Repos',
    path: '/top-repos',
    description: 'Repositories ranked by commit/LOC volume.',
    roles: ALL_ROLES,
  },
  // Team Capacity was retired into Engineering Activity §Watchlist (2026-08-25).
  // It answered "who has no PR activity in this window" — the same question,
  // over a narrower signal set, that the Watchlist's recency buckets answer
  // over commits, PRs opened, merges and reviews together. Two routes for one
  // question is the duplication this section was reorganised to remove; the
  // frontend redirects `/team-capacity` so existing links keep working.
];

/** BC-13 insight endpoints backing the common dashboards. JWT + tenant-scoped. */
@Controller('dashboards')
export class InsightsController {
  constructor(
    private readonly insights: InsightsService,
    private readonly devActivity: DeveloperActivityService,
    private readonly correlation: CorrelationService,
    private readonly code: CodeService,
    // Read-only, for the collection watermark the 12-month trend needs to tell
    // an empty month from an unwalked one. BC-13 never reaches a source itself.
    private readonly connections: ConnectionsService,
  ) {}

  /** Dashboards visible to the current user's roles (role-based assignment). */
  @Get('assignments')
  assignments(@CurrentUser() user: AuthUser) {
    const roles = new Set(user.roles);
    return {
      dashboards: DASHBOARD_REGISTRY.filter((d) =>
        d.roles.some((r) => roles.has(r)),
      ).map(({ key, title, path, description, children }) => ({
        key,
        title,
        path,
        description,
        // Omitted rather than sent empty, so a frontend deployed before this
        // change sees exactly the payload it saw yesterday.
        ...(children ? { children } : {}),
      })),
    };
  }

  /** Work-item detailing: story/bug/subtask/epic rows + linked PRs. */
  @Get('work-items')
  workItems(
    @Query('projects') projects?: string,
    @Query('types') types?: string,
    @Query('sprint') sprint?: string,
    @Query('epic') epic?: string,
    @Query('release') release?: string,
    @Query('assignee') assignee?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.insights
      .workItems({
        projects: parseList(projects),
        types: parseList(types),
        sprintExternalId: sprint || undefined,
        epicKey: epic || undefined,
        release: release || undefined,
        assigneeLogin: assignee || undefined,
        from: parseDate(from),
        to: parseDate(to),
      })
      .then((items) => ({ items, computedAt: new Date().toISOString() }));
  }

  /**
   * Health of EVERY active sprint in scope — one card per project's concurrent
   * sprint lifecycle, ranked worst-pace-first (multi-project default view).
   */
  @Get('sprint-health/active')
  async activeSprintsHealth(@Query('projects') projects?: string) {
    const view = await this.insights.activeSprintsHealth(parseList(projects));
    return { ...view, computedAt: new Date().toISOString() };
  }

  @Get('sprint-health')
  async sprintHealth(@Query('sprint') sprint?: string) {
    const view = await this.insights.sprintHealth(
      requireParam(sprint, 'sprint'),
    );
    if (!view) {
      throw new NotFoundException('Sprint not found.');
    }
    return view;
  }

  /** Risk of EVERY active sprint in scope, ranked most-at-risk-first. */
  @Get('sprint-risk/active')
  async activeSprintsRisk(@Query('projects') projects?: string) {
    const view = await this.insights.activeSprintsRisk(parseList(projects));
    return { ...view, computedAt: new Date().toISOString() };
  }

  @Get('sprint-risk')
  async sprintRisk(@Query('sprint') sprint?: string) {
    const view = await this.insights.sprintRisk(requireParam(sprint, 'sprint'));
    if (!view) {
      throw new NotFoundException('Sprint not found.');
    }
    return view;
  }

  @Get('velocity')
  velocity(
    @Query('projects') projects?: string,
    @Query('limit') limit?: string,
  ) {
    const n = parseInt(limit ?? '6', 10);
    return this.insights
      .velocity(parseList(projects), Number.isFinite(n) && n > 0 ? n : 6)
      .then((groups) => ({ groups, computedAt: new Date().toISOString() }));
  }

  @Get('forecast')
  forecast(@Query('projects') projects?: string) {
    return this.insights
      .forecast(parseList(projects))
      .then((rows) => ({ rows, computedAt: new Date().toISOString() }));
  }

  @Get('productivity')
  async productivity(
    @CurrentUser() user: AuthUser,
    @Query('projects') projects?: string,
    @Query('repos') repos?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const projectKeys = parseList(projects);
    const scopeRepos = await this.resolveRepos(
      user.tenantId,
      parseList(repos),
      projectKeys,
    );
    const fromDate = parseDate(from) ?? defaultFrom();
    const weeks = await this.insights.productivity(
      projectKeys,
      scopeRepos,
      fromDate,
      parseDate(to),
    );
    return { weeks, computedAt: new Date().toISOString() };
  }

  @Get('efficiency')
  async efficiency(
    @CurrentUser() user: AuthUser,
    @Query('projects') projects?: string,
    @Query('repos') repos?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const projectKeys = parseList(projects);
    const scopeRepos = await this.resolveRepos(
      user.tenantId,
      parseList(repos),
      projectKeys,
    );
    const fromDate = parseDate(from) ?? defaultFrom();
    const view = await this.insights.efficiency(
      projectKeys,
      scopeRepos,
      fromDate,
      parseDate(to),
    );
    return { ...view, computedAt: new Date().toISOString() };
  }

  /**
   * Flow metrics from the status-transition timeline. `agingDays` is the
   * threshold beyond which an in-progress item counts as ageing (METRICS.md
   * makes this tenant-configurable; it's a query param until that config
   * surface exists).
   */
  @Get('flow')
  async flow(
    @Query('projects') projects?: string,
    @Query('agingDays') agingDays?: string,
  ) {
    const threshold = Number(agingDays ?? 7);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      throw new BadRequestException('agingDays must be a positive number.');
    }
    const view = await this.insights.flowMetrics(
      parseList(projects),
      threshold,
    );
    return { ...view, computedAt: new Date().toISOString() };
  }

  /** Most-active projects for day|week|month (commits/LOC over mapped repos). */
  @Get('project-activity')
  async projectActivity(@Query('window') window = 'week') {
    const days = ACTIVITY_WINDOWS[window];
    if (!days) {
      throw new BadRequestException(
        `Unsupported window: ${window}. Supported: ${Object.keys(ACTIVITY_WINDOWS).join(', ')}.`,
      );
    }
    const view = await this.insights.projectActivity(istWindowFloor(days));
    return { window, ...view, computedAt: new Date().toISOString() };
  }

  /**
   * Team-level daily commit log: which developers committed on each day, with
   * counts. Activity context, not a ranking — developers come back
   * alphabetical per day; a volume sort is the reader's explicit act in the
   * UI (DASHBOARDS.md §4.1.3).
   */
  @Get('developer-activity/daily')
  async dailyDeveloperActivity(@Query('window') window = 'month') {
    const days = ACTIVITY_WINDOWS[window] ?? 30;
    const view = await this.insights.dailyCommitActivity(
      [],
      istWindowFloor(days),
    );
    // `windowDays` is the range actually measured, which is not always the one
    // asked for: an unrecognised window falls back to 30 rather than 400ing, so
    // a frontend deployed ahead of this backend keeps working (§ frontend/
    // backend skew). Echoing only the requested key would then label 30 days of
    // data as "90 days" — the board renders its interval from this number so it
    // states what was measured, never what was requested.
    return {
      window,
      windowDays: days,
      ...view,
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * Engineering Activity §Overview — team-shaped totals, the daily commit series
   * with its contributors, and both coverage figures.
   *
   * Carries no per-developer roster on purpose: the Watchlist owns people, and
   * rendering the same roster on both is what made the two pages one dataset
   * (DASHBOARDS.md §4.4.1).
   */
  @Get('developer-activity/overview')
  async developerActivityOverview(
    @Query('window') window = 'week',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = resolveActivityRange(window, from, to);
    const view = await this.devActivity.overview(
      [],
      range.from,
      range.to,
      range.windowDays,
    );
    return { window, ...view };
  }

  /**
   * Engineering Activity §Overview — commit and changed-LOC volume per month
   * over the last year.
   *
   * Takes no window parameter: it is a trend, and one that resized with the
   * section's range selector could not be compared against itself between two
   * visits. The 12 months are fixed and the widget says so on screen.
   *
   * The collection watermark is read here rather than inside the metrics
   * service so BC-8 keeps its hands off connection tables — the same
   * composition the freshness endpoint does, and the reason a month the
   * backfill never reached can be drawn as a gap instead of a zero.
   */
  @Get('developer-activity/monthly-trend')
  async developerActivityMonthlyTrend(@CurrentUser() user: AuthUser) {
    const freshness = await this.connections.getDataFreshness(user.tenantId);
    return this.devActivity.monthlyTrend([], freshness.collectedBackTo);
  }

  /**
   * Engineering Activity §Watchlist — recency buckets and the planning gap.
   *
   * A prompt to ask a question, never a conclusion about a person. Both
   * coverage figures ride along because an unmatched Jira assignee and a
   * developer with nothing assigned are the same absence on screen and
   * opposite findings in fact (DASHBOARDS.md §4.4.2).
   */
  @Get('developer-activity/watchlist')
  async developerActivityWatchlist(
    @Query('window') window = 'week',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = resolveActivityRange(window, from, to);
    const view = await this.devActivity.watchlist(
      range.from,
      range.to,
      range.windowDays,
    );
    return { window, ...view };
  }

  /**
   * Engineering Activity §PR Status — the review queue and how load is spread.
   *
   * Reports no cycle-time percentiles: those are Efficiency's, over a
   * merged-only denominator (DASHBOARDS.md §4.4.4).
   */
  @Get('developer-activity/pr-status')
  async developerActivityPrStatus(
    @Query('window') window = 'week',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = resolveActivityRange(window, from, to);
    const view = await this.devActivity.prStatus(
      [],
      range.from,
      range.to,
      range.windowDays,
    );
    return { window, ...view };
  }

  /** GitHub-style per-developer activity (commit history, repos, LOC, projects). */
  @Get('developer-activity')
  async developerActivity(
    @Query('developer') developer?: string,
    @Query('window') window = 'month',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = resolveActivityRange(window, from, to);
    const who = requireParam(developer, 'developer');
    // Fetched alongside rather than folded into `developerActivity`: reviews
    // given and assigned Jira work are BC-5/BC-6 facts about the person, not
    // commit-history facts, and keeping them separate leaves the older read
    // model untouched for every other caller.
    const [view, context] = await Promise.all([
      // `range.to` was previously left to default to now. A range that ends in
      // the past has to pass it, or the profile answers for a wider range than
      // the one its own heading states.
      this.insights.developerActivity(who, range.from, range.to),
      this.devActivity.developerContext(who, range.from, range.to),
    ]);
    // Every other insight endpoint stamps this; this one didn't, which is why
    // the board had no way to show when its numbers were computed.
    // `windowDays`: see the daily endpoint — the range measured, not requested.
    return {
      windowDays: range.windowDays,
      ...view,
      ...context,
      computedAt: new Date().toISOString(),
    };
  }

  private async resolveRepos(
    tenantId: string,
    explicit: string[],
    projects: string[],
  ): Promise<string[]> {
    if (explicit.length > 0) {
      return explicit;
    }
    if (projects.length > 0) {
      return this.correlation.reposLinkedToProjects(tenantId, projects);
    }
    // Every repo, not the picker's first page — see CodeService.listAllRepos.
    return this.code.listAllRepos(tenantId);
  }
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) {
    throw new BadRequestException(`Query param "${name}" is required.`);
  }
  return value;
}

function parseDate(value?: string): Date | undefined {
  if (!value) {
    return undefined;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function defaultFrom(): Date {
  return new Date(Date.now() - 30 * 86_400_000);
}
