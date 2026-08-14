import { EventBus } from '../../common/events/event-bus';
import { PlanningStoryPayload } from '../../common/events/contracts';
import { DomainEvent } from '../../common/events/domain-event';
import { EventTypes } from '../../common/events/event-types';
import { PrismaService } from '../../database/prisma.service';
import { PlanningService } from './planning.service';

function storyEvent(
  payload: Partial<PlanningStoryPayload>,
): DomainEvent<PlanningStoryPayload> {
  return {
    type: EventTypes.PLANNING_STORY_UPDATED,
    tenantId: 'tenant-a',
    connectionId: 'conn_1',
    sourceEventIds: ['evt_1'],
    occurredAt: new Date('2026-06-05T00:00:00.000Z'),
    payload: {
      externalKey: 'PAY-1',
      projectKey: 'PAY',
      status: 'Done',
      title: 't',
      ...payload,
    },
  };
}

describe('PlanningService — status-transition timeline', () => {
  let prisma: {
    story: { upsert: jest.Mock };
    sprint: { upsert: jest.Mock };
    release: { upsert: jest.Mock };
    issueStatusHistory: { createMany: jest.Mock };
    sprintScopeChange: { createMany: jest.Mock };
  };
  let service: PlanningService;

  // handleStory is private and only reachable via the bus subscription, which
  // is how it runs in production — subscribe once and invoke what it registered.
  let handle: (e: DomainEvent<PlanningStoryPayload>) => Promise<void>;

  beforeEach(() => {
    prisma = {
      story: { upsert: jest.fn().mockResolvedValue({}) },
      sprint: { upsert: jest.fn().mockResolvedValue({}) },
      release: { upsert: jest.fn().mockResolvedValue({}) },
      issueStatusHistory: { createMany: jest.fn().mockResolvedValue({}) },
      sprintScopeChange: { createMany: jest.fn().mockResolvedValue({}) },
    };
    const handlers: ((
      e: DomainEvent<PlanningStoryPayload>,
    ) => Promise<void>)[] = [];
    const bus = {
      subscribe: jest.fn((_type: string, fn: never) => handlers.push(fn)),
    } as unknown as EventBus;

    service = new PlanningService(prisma as unknown as PrismaService, bus);
    service.onModuleInit();
    handle = handlers[0];
  });

  it('records each status transition and persists the status category on the story', async () => {
    await handle(
      storyEvent({
        statusCategory: 'done',
        transitions: [
          {
            changelogId: '800',
            toStatus: 'To Do',
            at: '2026-06-01T00:00:00.000Z',
          },
          {
            changelogId: '900',
            fromStatus: 'To Do',
            toStatus: 'Done',
            at: '2026-06-03T00:00:00.000Z',
            authorLogin: 'acc_1',
            authorName: 'Jane Doe',
          },
        ],
      }),
    );

    expect(prisma.issueStatusHistory.createMany).toHaveBeenCalledTimes(1);
    const arg = prisma.issueStatusHistory.createMany.mock.calls[0][0] as {
      data: Record<string, unknown>[];
      skipDuplicates: boolean;
    };
    expect(arg.data).toHaveLength(2);
    expect(arg.data[1]).toMatchObject({
      tenantId: 'tenant-a',
      connectionId: 'conn_1',
      externalKey: 'PAY-1',
      changelogId: '900',
      fromStatus: 'To Do',
      toStatus: 'Done',
      authorLogin: 'acc_1',
      authorName: 'Jane Doe',
    });
    expect(arg.data[1].transitionedAt).toEqual(
      new Date('2026-06-03T00:00:00.000Z'),
    );
    // First transition has no prior status — stored as null, not dropped.
    expect(arg.data[0]).toMatchObject({ changelogId: '800', fromStatus: null });

    expect(prisma.story.upsert).toHaveBeenCalledTimes(1);
    const upsert = prisma.story.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(upsert.update.statusCategory).toBe('done');
  });

  it('de-dupes on replay rather than duplicating the timeline', async () => {
    // A backfill re-walk, a boundary re-poll and a webhook for an
    // already-polled transition all deliver the same changelog id. Inserting it
    // twice would silently inflate every duration derived from the timeline.
    await handle(
      storyEvent({
        transitions: [
          {
            changelogId: '900',
            toStatus: 'Done',
            at: '2026-06-03T00:00:00.000Z',
          },
        ],
      }),
    );

    const arg = prisma.issueStatusHistory.createMany.mock.calls[0][0] as {
      skipDuplicates: boolean;
    };
    expect(arg.skipDuplicates).toBe(true);
  });

  it('does not touch the timeline when the event carries no transitions', async () => {
    await handle(storyEvent({}));

    expect(prisma.issueStatusHistory.createMany).not.toHaveBeenCalled();
    expect(prisma.story.upsert).toHaveBeenCalledTimes(1);
  });

  it('explodes each sprint change into one row per sprint touched, deduped on replay', async () => {
    await handle(
      storyEvent({
        sprintChanges: [
          {
            // one changelog entry moving PAY-1 from sprint 5 to sprint 7 —
            // two rows sharing the changelog id, split by sprint + action
            changelogId: '760',
            addedSprintIds: ['7'],
            removedSprintIds: ['5'],
            at: '2026-06-04T00:00:00.000Z',
            authorLogin: 'acc_1',
            authorName: 'Jane Doe',
          },
        ],
      }),
    );

    expect(prisma.sprintScopeChange.createMany).toHaveBeenCalledTimes(1);
    const arg = prisma.sprintScopeChange.createMany.mock.calls[0][0] as {
      data: Record<string, unknown>[];
      skipDuplicates: boolean;
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    expect(arg.data[0]).toMatchObject({
      tenantId: 'tenant-a',
      connectionId: 'conn_1',
      externalKey: 'PAY-1',
      sprintExternalId: '7',
      action: 'added',
      changelogId: '760',
      authorLogin: 'acc_1',
      authorName: 'Jane Doe',
    });
    expect(arg.data[0].changedAt).toEqual(new Date('2026-06-04T00:00:00.000Z'));
    expect(arg.data[1]).toMatchObject({
      sprintExternalId: '5',
      action: 'removed',
      changelogId: '760',
    });
  });

  it('does not touch the scope timeline when the event carries no sprint changes', async () => {
    await handle(storyEvent({}));

    expect(prisma.sprintScopeChange.createMany).not.toHaveBeenCalled();
  });

  it("persists Jira's creation date, and never overwrites a known one with null", async () => {
    await handle(storyEvent({ sourceCreatedAt: '2026-01-04T09:30:00.000Z' }));

    const withDate = prisma.story.upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(withDate.create.sourceCreatedAt).toEqual(
      new Date('2026-01-04T09:30:00.000Z'),
    );
    expect(withDate.update.sourceCreatedAt).toEqual(
      new Date('2026-01-04T09:30:00.000Z'),
    );

    // An event from a path that doesn't collect the field must leave an
    // already-resolved date alone: writing null would silently drop the item
    // out of lead time, and re-resolving it needs a full Jira re-walk.
    await handle(storyEvent({}));

    const without = prisma.story.upsert.mock.calls[1][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(without.update).not.toHaveProperty('sourceCreatedAt');
    expect(without.create.sourceCreatedAt).toBeNull();
  });
});
