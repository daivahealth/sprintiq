import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { Role } from '../../common/auth/role.enum';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { CorrelationService } from '../../correlation/correlation.service';
import { MetricsService } from '../../metrics/metrics.service';
import { CodeService } from '../code/code.service';
import { PlanningService } from '../planning/planning.service';
import { parseList } from './catalog.controller';

/** Metrics the batch endpoint can serve today; grows with the widget registry. */
const SUPPORTED_METRICS = ['pr_cycle_time', 'loc_added_deleted', 'bug_count'];
const SUPPORTED_GROUPS = ['repo', 'project', 'developer', 'day'];

const DASHBOARD_ROLES = [
  Role.DEVELOPER,
  Role.TEAM_LEAD,
  Role.SCRUM_MASTER,
  Role.ENG_MANAGER,
  Role.PRODUCT_OWNER,
  Role.CTO,
  Role.ADMIN,
];

/**
 * BC-13 Dashboards & Reporting (read BFF). JWT-guarded globally; tenant resolved
 * from the token. The batch `metrics` endpoint is the scope system's engine:
 * N metrics × M entities in one call (DASHBOARDS.md §3/§6).
 */
@Controller('dashboards')
export class DashboardsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly code: CodeService,
    private readonly correlation: CorrelationService,
    private readonly planning: PlanningService,
  ) {}

  /** Single-repo endpoint retained for compatibility; the UI uses `metrics`. */
  @Roles(...DASHBOARD_ROLES)
  @Get('pr-cycle-time')
  getPrCycleTime(@Query('repo') repo?: string) {
    if (!repo) {
      throw new BadRequestException(
        'Query param "repo" is required (owner/name).',
      );
    }
    return this.metrics.computePrCycleTime(repo);
  }

  /**
   * Batch metrics over a scope, grouped by repo.
   * Scope resolution: explicit `repos` > repos linked to `projects` (delivery
   * graph) > first page of the tenant's repo catalog.
   */
  @Roles(...DASHBOARD_ROLES)
  @Get('metrics')
  async getMetrics(
    @CurrentUser() user: AuthUser,
    @Query('metrics') metrics?: string,
    @Query('repos') repos?: string,
    @Query('projects') projects?: string,
    @Query('groupBy') groupBy = 'repo',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const metricKeys = parseList(metrics);
    if (metricKeys.length === 0) {
      throw new BadRequestException('Query param "metrics" is required.');
    }
    const unsupported = metricKeys.filter(
      (k) => !SUPPORTED_METRICS.includes(k),
    );
    if (unsupported.length > 0) {
      throw new BadRequestException(
        `Unsupported metric(s): ${unsupported.join(', ')}. Supported: ${SUPPORTED_METRICS.join(', ')}.`,
      );
    }
    if (!SUPPORTED_GROUPS.includes(groupBy)) {
      throw new BadRequestException(
        `Unsupported groupBy: ${groupBy}. Supported: ${SUPPORTED_GROUPS.join(', ')}.`,
      );
    }

    const projectKeys = parseList(projects);
    const explicitRepos = parseList(repos);
    const fromDate = parseDate(from);
    const toDate = parseDate(to);
    const scopeRepos = await this.resolveRepos(
      user.tenantId,
      explicitRepos,
      projectKeys,
    );
    let rows;
    if (groupBy === 'project') {
      rows = await this.metrics.computeMetricsForProjects(
        metricKeys,
        await this.resolveProjects(user.tenantId, projectKeys),
        fromDate,
        toDate,
      );
    } else if (groupBy === 'developer') {
      rows = await this.metrics.computeMetricsForDevelopers(
        metricKeys,
        scopeRepos,
        fromDate,
        toDate,
      );
    } else if (groupBy === 'day') {
      rows = await this.metrics.computeMetricsByDay(
        metricKeys,
        scopeRepos,
        projectKeys,
        fromDate,
        toDate,
      );
    } else {
      rows = await this.metrics.computeMetricsForRepos(
        metricKeys,
        scopeRepos,
        fromDate,
        toDate,
      );
    }

    return {
      groupBy,
      scope: { repos: scopeRepos, projects: projectKeys, from, to },
      rows,
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
    return this.code.listRepos(tenantId, undefined, 1, 50);
  }

  private async resolveProjects(
    tenantId: string,
    explicit: string[],
  ): Promise<string[]> {
    if (explicit.length > 0) {
      return explicit;
    }
    return this.planning.listProjectKeys(tenantId);
  }
}

function parseDate(value?: string): Date | undefined {
  if (!value) {
    return undefined;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
