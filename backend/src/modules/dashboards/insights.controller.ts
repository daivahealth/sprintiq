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
import { CorrelationService } from '../../correlation/correlation.service';
import { InsightsService } from '../../metrics/insights.service';
import { CodeService } from '../code/code.service';
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
}[] = [
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
    key: 'project-activity',
    title: 'Project Activity',
    path: '/project-activity',
    description:
      'Most-active projects (commits + LOC across mapped repos) by day/week/month.',
    roles: ALL_ROLES,
  },
  {
    key: 'developer-activity',
    title: 'Developer Activity',
    path: '/developer-activity',
    description:
      'Per-developer commit history, repos, lines committed, active projects.',
    roles: ALL_ROLES,
  },
];

/** Activity windows for the Project Activity board. */
const ACTIVITY_WINDOWS: Record<string, number> = {
  day: 1,
  week: 7,
  month: 30,
};

/** BC-13 insight endpoints backing the common dashboards. JWT + tenant-scoped. */
@Controller('dashboards')
export class InsightsController {
  constructor(
    private readonly insights: InsightsService,
    private readonly correlation: CorrelationService,
    private readonly code: CodeService,
  ) {}

  /** Dashboards visible to the current user's roles (role-based assignment). */
  @Get('assignments')
  assignments(@CurrentUser() user: AuthUser) {
    const roles = new Set(user.roles);
    return {
      dashboards: DASHBOARD_REGISTRY.filter((d) =>
        d.roles.some((r) => roles.has(r)),
      ).map(({ key, title, path, description }) => ({
        key,
        title,
        path,
        description,
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
      .then((rows) => ({ rows, computedAt: new Date().toISOString() }));
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

  /** Most-active projects for day|week|month (commits/LOC over mapped repos). */
  @Get('project-activity')
  async projectActivity(@Query('window') window = 'week') {
    const days = ACTIVITY_WINDOWS[window];
    if (!days) {
      throw new BadRequestException(
        `Unsupported window: ${window}. Supported: ${Object.keys(ACTIVITY_WINDOWS).join(', ')}.`,
      );
    }
    const rows = await this.insights.projectActivity(
      new Date(Date.now() - days * 86_400_000),
    );
    return { window, rows, computedAt: new Date().toISOString() };
  }

  /** GitHub-style per-developer activity (commit history, repos, LOC, projects). */
  @Get('developer-activity')
  async developerActivity(
    @Query('developer') developer?: string,
    @Query('window') window = 'month',
  ) {
    const days = ACTIVITY_WINDOWS[window] ?? 30;
    return this.insights.developerActivity(
      requireParam(developer, 'developer'),
      new Date(Date.now() - days * 86_400_000),
    );
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
    return this.code.listRepos(tenantId, undefined, 1, 50);
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
