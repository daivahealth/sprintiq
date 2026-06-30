import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Story } from '@prisma/client';
import { PlanningStoryPayload } from '../../common/events/contracts';
import { PLANNING_STORY_EVENT_TYPES } from '../../common/events/event-types';
import { DomainEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus';
import { newId } from '../../common/id';
import { PrismaService } from '../../database/prisma.service';

/**
 * BC-3 Planning (Jira domain). Consumes planning.issue.* events and upserts
 * stories; exposes lookup by Jira key for correlation.
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
    const fields = {
      connectionId: event.connectionId ?? '',
      projectKey: p.projectKey,
      type: p.type ?? 'story',
      status: p.status,
      storyPoints: p.storyPoints ?? null,
      title: p.title,
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

    this.logger.debug(`upserted story ${p.externalKey} (${p.status})`);
  }

  /** Resolve a story by its Jira key within a tenant (correlation target). */
  findByKey(tenantId: string, externalKey: string): Promise<Story | null> {
    return this.prisma.story.findUnique({
      where: { tenantId_externalKey: { tenantId, externalKey } },
    });
  }
}
