import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Release, Sprint, Story } from '@prisma/client';
import {
  PlanningSprintRef,
  PlanningStoryPayload,
} from '../../common/events/contracts';
import { PLANNING_STORY_EVENT_TYPES } from '../../common/events/event-types';
import { DomainEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus';
import { newId } from '../../common/id';
import { PrismaService } from '../../database/prisma.service';

/** Statuses treated as "done" for velocity/health math (tenant-tunable later). */
export const DONE_STATUSES = ['Done', 'Closed', 'Resolved'];

/** Work-item detail filters — the detailing dimensions (DASHBOARDS.md). */
export interface WorkItemFilters {
  projects?: string[];
  types?: string[]; // story | bug | task | spike | subtask | epic
  sprintExternalId?: string;
  epicKey?: string;
  release?: string;
  assigneeLogin?: string;
  from?: Date;
  to?: Date;
}

/**
 * BC-3 Planning (Jira domain). Consumes planning.issue.* events and upserts the
 * full work-item detail (hierarchy, sprint, releases, assignee); exposes the
 * detailing reads every dashboard granularity is built on.
 */
@Injectable()
export class PlanningService implements OnModuleInit {
  private readonly logger = new Logger(PlanningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {}

  onModuleInit(): void {
    for (const type of PLANNING_STORY_EVENT_TYPES) {
      this.eventBus.subscribe<PlanningStoryPayload>(type, (e) =>
        this.handleStory(e),
      );
    }
  }

  private async handleStory(
    event: DomainEvent<PlanningStoryPayload>,
  ): Promise<void> {
    const p = event.payload;
    const connectionId = event.connectionId ?? '';

    if (p.sprint) {
      await this.upsertSprint(
        event.tenantId,
        connectionId,
        p.projectKey,
        p.sprint,
      );
    }
    for (const release of p.releases ?? []) {
      await this.upsertRelease(
        event.tenantId,
        connectionId,
        p.projectKey,
        release,
      );
    }

    const fields = {
      connectionId,
      projectKey: p.projectKey,
      type: p.type ?? 'story',
      status: p.status,
      storyPoints: p.storyPoints ?? null,
      title: p.title,
      epicKey: p.epicKey ?? null,
      parentKey: p.parentKey ?? null,
      sprintExternalId: p.sprint?.externalId ?? null,
      releases: p.releases ?? [],
      assigneeLogin: p.assigneeLogin ?? null,
      assigneeName: p.assigneeName ?? null,
      priority: p.priority ?? null,
      resolvedAt: p.resolvedAt ? new Date(p.resolvedAt) : null,
    };

    await this.prisma.story.upsert({
      where: {
        tenantId_externalKey: {
          tenantId: event.tenantId,
          externalKey: p.externalKey,
        },
      },
      create: {
        id: newId(),
        tenantId: event.tenantId,
        externalKey: p.externalKey,
        ...fields,
      },
      update: fields,
    });

    this.logger.debug(`upserted ${fields.type} ${p.externalKey} (${p.status})`);
  }

  private async upsertSprint(
    tenantId: string,
    connectionId: string,
    projectKey: string,
    sprint: PlanningSprintRef,
  ): Promise<void> {
    const fields = {
      connectionId,
      name: sprint.name,
      state: sprint.state ?? 'active',
      projectKey,
      startAt: sprint.startAt ? new Date(sprint.startAt) : null,
      endAt: sprint.endAt ? new Date(sprint.endAt) : null,
      goal: sprint.goal ?? null,
    };
    await this.prisma.sprint.upsert({
      where: {
        tenantId_externalId: { tenantId, externalId: sprint.externalId },
      },
      create: {
        id: newId(),
        tenantId,
        externalId: sprint.externalId,
        ...fields,
      },
      update: fields,
    });
  }

  private async upsertRelease(
    tenantId: string,
    connectionId: string,
    projectKey: string,
    name: string,
  ): Promise<void> {
    await this.prisma.release.upsert({
      where: { tenantId_projectKey_name: { tenantId, projectKey, name } },
      create: { id: newId(), tenantId, connectionId, name, projectKey },
      update: {},
    });
  }

  // ---- Detailing reads (catalog + work-item level) -------------------------

  listSprints(
    tenantId: string,
    projectKeys?: string[],
    state?: string,
  ): Promise<Sprint[]> {
    return this.prisma.sprint.findMany({
      where: {
        tenantId,
        ...(projectKeys && projectKeys.length > 0
          ? { projectKey: { in: projectKeys } }
          : {}),
        ...(state ? { state } : {}),
      },
      orderBy: [{ endAt: 'desc' }, { name: 'desc' }],
      take: 100,
    });
  }

  listReleases(tenantId: string, projectKeys?: string[]): Promise<Release[]> {
    return this.prisma.release.findMany({
      where: {
        tenantId,
        ...(projectKeys && projectKeys.length > 0
          ? { projectKey: { in: projectKeys } }
          : {}),
      },
      orderBy: [{ releaseDate: 'desc' }, { name: 'asc' }],
      take: 100,
    });
  }

  listEpics(tenantId: string, projectKeys?: string[]): Promise<Story[]> {
    return this.prisma.story.findMany({
      where: {
        tenantId,
        type: 'epic',
        ...(projectKeys && projectKeys.length > 0
          ? { projectKey: { in: projectKeys } }
          : {}),
      },
      orderBy: { externalKey: 'asc' },
      take: 200,
    });
  }

  /** Work items at any granularity: story/bug/subtask/epic × sprint/release/epic/assignee. */
  listWorkItems(tenantId: string, filters: WorkItemFilters): Promise<Story[]> {
    return this.prisma.story.findMany({
      where: {
        tenantId,
        ...(filters.projects && filters.projects.length > 0
          ? { projectKey: { in: filters.projects } }
          : {}),
        ...(filters.types && filters.types.length > 0
          ? { type: { in: filters.types } }
          : {}),
        ...(filters.sprintExternalId
          ? { sprintExternalId: filters.sprintExternalId }
          : {}),
        ...(filters.epicKey ? { epicKey: filters.epicKey } : {}),
        ...(filters.release ? { releases: { has: filters.release } } : {}),
        ...(filters.assigneeLogin
          ? { assigneeLogin: filters.assigneeLogin }
          : {}),
        ...(filters.from || filters.to
          ? {
              updatedAt: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lte: filters.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { externalKey: 'asc' },
      take: 500,
    });
  }

  /** Items committed to a sprint (velocity / health / risk inputs). */
  listItemsForSprint(
    tenantId: string,
    sprintExternalId: string,
  ): Promise<Story[]> {
    return this.prisma.story.findMany({
      where: { tenantId, sprintExternalId },
    });
  }

  /** Open (not-done) non-epic backlog for forecasting. */
  listOpenBacklog(tenantId: string, projectKeys: string[]): Promise<Story[]> {
    return this.prisma.story.findMany({
      where: {
        tenantId,
        ...(projectKeys.length > 0 ? { projectKey: { in: projectKeys } } : {}),
        type: { notIn: ['epic'] },
        status: { notIn: DONE_STATUSES },
      },
    });
  }

  /** Resolve a story by its Jira key within a tenant (correlation target). */
  findByKey(tenantId: string, externalKey: string): Promise<Story | null> {
    return this.prisma.story.findUnique({
      where: { tenantId_externalKey: { tenantId, externalKey } },
    });
  }

  /** Distinct project keys known to this tenant (catalog for pickers/portfolio). */
  async listProjectKeys(tenantId: string, search?: string): Promise<string[]> {
    const rows = await this.prisma.story.findMany({
      where: {
        tenantId,
        ...(search ? { projectKey: { contains: search.toUpperCase() } } : {}),
      },
      distinct: ['projectKey'],
      select: { projectKey: true },
      orderBy: { projectKey: 'asc' },
      take: 100,
    });
    return rows.map((r) => r.projectKey);
  }

  /** Story ids for a set of projects (input to graph cross-filtering). */
  async listStoryIdsForProjects(
    tenantId: string,
    projectKeys: string[],
  ): Promise<string[]> {
    if (projectKeys.length === 0) {
      return [];
    }
    const rows = await this.prisma.story.findMany({
      where: { tenantId, projectKey: { in: projectKeys } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** Story ids with project keys for graph rollups. */
  async listStoryRefsForProjects(
    tenantId: string,
    projectKeys: string[],
  ): Promise<Array<{ id: string; projectKey: string }>> {
    if (projectKeys.length === 0) {
      return [];
    }
    return this.prisma.story.findMany({
      where: { tenantId, projectKey: { in: projectKeys } },
      select: { id: true, projectKey: true },
    });
  }

  async listBugStoryIds(
    tenantId: string,
    storyIds: string[],
    from?: Date,
    to?: Date,
  ): Promise<string[]> {
    if (storyIds.length === 0) {
      return [];
    }
    const rows = await this.prisma.story.findMany({
      where: {
        tenantId,
        id: { in: storyIds },
        type: 'bug',
        updatedAt: {
          ...(from ? { gte: from } : {}),
          ...(to ? { lte: to } : {}),
        },
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /** Bug story ids grouped by project for dashboard defect context. */
  async listBugStoryIdsByProject(
    tenantId: string,
    projectKeys: string[],
    from?: Date,
    to?: Date,
  ): Promise<Map<string, string[]>> {
    if (projectKeys.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.story.findMany({
      where: {
        tenantId,
        projectKey: { in: projectKeys },
        type: 'bug',
        updatedAt: {
          ...(from ? { gte: from } : {}),
          ...(to ? { lte: to } : {}),
        },
      },
      select: { id: true, projectKey: true },
    });
    const byProject = new Map<string, string[]>();
    for (const row of rows) {
      byProject.set(row.projectKey, [
        ...(byProject.get(row.projectKey) ?? []),
        row.id,
      ]);
    }
    return byProject;
  }

  /** Bug work items grouped by update date for dashboard day trends. */
  async listBugCountsByDay(
    tenantId: string,
    projectKeys: string[],
    from?: Date,
    to?: Date,
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.story.findMany({
      where: {
        tenantId,
        ...(projectKeys.length > 0 ? { projectKey: { in: projectKeys } } : {}),
        type: 'bug',
        updatedAt: {
          ...(from ? { gte: from } : {}),
          ...(to ? { lte: to } : {}),
        },
      },
      select: { updatedAt: true },
    });
    const byDay = new Map<string, number>();
    for (const row of rows) {
      const day = row.updatedAt.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    return byDay;
  }
}
