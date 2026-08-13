import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { CorrelationService } from '../../correlation/correlation.service';
import { DeveloperIdentityService } from '../../correlation/developer-identity.service';
import { CodeService } from '../../modules/code/code.service';
import { PlanningService } from '../../modules/planning/planning.service';

/**
 * BC-13 entity catalogs for the scope system's pickers (DASHBOARDS.md §3/§6).
 * Read-only, tenant-scoped from the JWT, available to every authenticated role
 * (RBAC narrows *data*, not entity names). Server-side search/pagination — the
 * frontend never loads all 200 repos eagerly.
 */
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly planning: PlanningService,
    private readonly code: CodeService,
    private readonly correlation: CorrelationService,
    private readonly identities: DeveloperIdentityService,
  ) {}

  @Get('projects')
  async projects(
    @CurrentUser() user: AuthUser,
    @Query('search') search?: string,
  ) {
    const keys = await this.planning.listProjectKeys(user.tenantId, search);
    return { items: keys.map((key) => ({ key })) };
  }

  /** Sprints (optionally by projects/state) for sprint-scoped dashboards. */
  @Get('sprints')
  async sprints(
    @CurrentUser() user: AuthUser,
    @Query('projects') projects?: string,
    @Query('state') state?: string,
  ) {
    const sprints = await this.planning.listSprints(
      user.tenantId,
      parseList(projects),
      state || undefined,
    );
    return {
      items: sprints.map((s) => ({
        externalId: s.externalId,
        name: s.name,
        state: s.state,
        projectKey: s.projectKey,
        startAt: s.startAt,
        endAt: s.endAt,
      })),
    };
  }

  /** Epics (type='epic' work items) for epic-wise detailing filters. */
  @Get('epics')
  async epics(
    @CurrentUser() user: AuthUser,
    @Query('projects') projects?: string,
  ) {
    const epics = await this.planning.listEpics(
      user.tenantId,
      parseList(projects),
    );
    return {
      items: epics.map((e) => ({
        key: e.externalKey,
        title: e.title,
        projectKey: e.projectKey,
        status: e.status,
      })),
    };
  }

  /**
   * Canonical developers — the developer-activity picker.
   *
   * Sourced from the resolved identity map rather than raw commit/PR logins, so
   * that people GitHub never attributed an account to are selectable at all:
   * the login-only catalog could not list them, which is precisely why their
   * work looked like nobody's. Falls back to the raw logins before the first
   * resolution pass has run.
   */
  @Get('developers')
  async developers(
    @CurrentUser() user: AuthUser,
    @Query('search') search?: string,
  ) {
    const resolved = await this.identities.listDevelopers(
      user.tenantId,
      search,
    );
    if (resolved.length > 0) {
      return {
        items: resolved.map((d) => ({
          login: d.canonicalDeveloperId,
          displayName: d.displayName,
          attributed: d.attributed,
        })),
      };
    }
    const logins = await this.code.listDeveloperLogins(user.tenantId, search);
    return {
      items: logins.map((login) => ({
        login,
        displayName: login,
        attributed: true,
      })),
    };
  }

  /** Releases (Jira fixVersions) for release-wise detailing filters. */
  @Get('releases')
  async releases(
    @CurrentUser() user: AuthUser,
    @Query('projects') projects?: string,
  ) {
    const releases = await this.planning.listReleases(
      user.tenantId,
      parseList(projects),
    );
    return {
      items: releases.map((r) => ({
        name: r.name,
        projectKey: r.projectKey,
        released: r.released,
        releaseDate: r.releaseDate,
      })),
    };
  }

  /**
   * Repos, cross-filtered by projects via the delivery graph when `projects`
   * is provided (repos whose PRs implement those projects' stories).
   */
  @Get('repos')
  async repos(
    @CurrentUser() user: AuthUser,
    @Query('search') search?: string,
    @Query('projects') projects?: string,
    @Query('page') page?: string,
  ) {
    const projectKeys = parseList(projects);
    if (projectKeys.length > 0) {
      let linked = await this.correlation.reposLinkedToProjects(
        user.tenantId,
        projectKeys,
      );
      if (search) {
        const needle = search.toLowerCase();
        linked = linked.filter((r) => r.toLowerCase().includes(needle));
      }
      return { items: linked.map((name) => ({ name })), crossFiltered: true };
    }
    const repos = await this.code.listRepos(
      user.tenantId,
      search,
      parsePage(page),
    );
    return { items: repos.map((name) => ({ name })), crossFiltered: false };
  }
}

export function parseList(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePage(value?: string): number {
  const n = parseInt(value ?? '1', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
