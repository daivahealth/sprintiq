import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Optional,
  Param,
  Query,
} from '@nestjs/common';
import { AUDIT_SINK, AuditSink } from '../../common/audit/audit-sink';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Role } from '../../common/auth/role.enum';
import { Roles } from '../../common/auth/roles.decorator';
import { AuthUser } from '../../common/tenancy/tenant-context.service';
import { KnowledgeGraphManager } from './graph-manager.service';
import {
  developerRepositories,
  KNOWLEDGE_GRAPH_RULE,
  repositoryActivities,
  repositoryDevelopers,
  resolveRepository,
  searchRepositories,
} from './graph-queries';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

/**
 * Knowledge-graph read API (docs/api/README.md §9, ANALYTICS.md §5).
 *
 * **Admins only, by the decision that permits it (ADR-0013):** these reads
 * name developers beside per-repository work counts. Every read that returns
 * names is audit-logged; `status` and `search` return none and are not. People
 * are always listed alphabetically, and the rule is shipped with every
 * named-person response.
 *
 * Tenant comes from the authenticated user only, and each tenant's graph is a
 * separate object, so no route can reach another tenant's data.
 */
@Controller('knowledge-graph')
export class KnowledgeGraphController {
  constructor(
    private readonly manager: KnowledgeGraphManager,
    @Optional() @Inject(AUDIT_SINK) private readonly audit?: AuditSink,
  ) {}

  /** Initialisation state and node/edge counts for the caller's tenant. */
  @Roles(Role.ADMIN)
  @Get('status')
  status(@CurrentUser() user: AuthUser) {
    return this.manager.status(user.tenantId);
  }

  /** Repositories whose `owner/name` or URL contains `q`, alphabetical. */
  @Roles(Role.ADMIN)
  @Get('repositories/search')
  search(
    @CurrentUser() user: AuthUser,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    const { graph, freshness } = this.manager.readyGraph(user.tenantId);
    const items = searchRepositories(graph, q ?? '', parseLimit(limit));
    return { items, count: items.length, freshness };
  }

  /**
   * Developers who worked in a repository, with their commit, PR and review
   * counts. `:id` is `owner/name` (URL-encoded), the repository URL, or a bare
   * name that only one repository carries.
   */
  @Roles(Role.ADMIN)
  @Get('repositories/:id/developers')
  async repositoryDevelopers(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    const { graph, freshness } = this.manager.readyGraph(user.tenantId);
    const view = repositoryDevelopers(graph, resolveRepository(graph, id));
    await this.audit?.record({
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.userId,
      action: 'analytics.knowledge_graph.repository_developers.view',
      targetType: 'repository',
      targetId: view.repository.id,
      metadata: { developerCount: view.developers.length },
    });
    return { ...view, rule: KNOWLEDGE_GRAPH_RULE, freshness };
  }

  /** Repositories a developer worked in, with their activity in each. */
  @Roles(Role.ADMIN)
  @Get('developers/:id/repositories')
  async developerRepositories(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const { graph, freshness } = this.manager.readyGraph(user.tenantId);
    const view = developerRepositories(graph, id, parseLimit(limit));
    await this.audit?.record({
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.userId,
      action: 'analytics.knowledge_graph.developer_repositories.view',
      targetType: 'developer',
      targetId: view.developer.developerId,
      metadata: { repositoryCount: view.repositories.length },
    });
    return { ...view, rule: KNOWLEDGE_GRAPH_RULE, freshness };
  }

  /** A repository's commits, PRs, reviews and linked Jira issues. */
  @Roles(Role.ADMIN)
  @Get('repositories/:id/activities')
  async repositoryActivities(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const { graph, freshness } = this.manager.readyGraph(user.tenantId);
    const view = repositoryActivities(
      graph,
      resolveRepository(graph, id),
      parseLimit(limit),
    );
    await this.audit?.record({
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.userId,
      action: 'analytics.knowledge_graph.repository_activities.view',
      targetType: 'repository',
      targetId: view.repository.id,
    });
    return { ...view, rule: KNOWLEDGE_GRAPH_RULE, freshness };
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_LIMIT;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new BadRequestException(
      `limit must be an integer from 1 to ${MAX_LIMIT}.`,
    );
  }
  return n;
}
