import {
  PlanningStoryPayload,
  PlanningWorklogsPayload,
} from '../../common/events/contracts';
import { DomainEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus';
import { EventTypes } from '../../common/events/event-types';
import { PrismaService } from '../../database/prisma.service';
import { PlanningService } from './planning.service';

/**
 * Worklog projection and the issue creator (ADR-0014, Sprint Health Efforts).
 * Kept apart from planning.service.spec so the snapshot rules — the part that
 * can erase data if it is wrong — are read on their own.
 */
describe('PlanningService — worklogs and creator', () => {
  let tx: {
    jiraWorklog: { upsert: jest.Mock; deleteMany: jest.Mock };
    story: { updateMany: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    story: { upsert: jest.Mock };
    sprint: { upsert: jest.Mock };
    release: { upsert: jest.Mock };
    issueStatusHistory: { createMany: jest.Mock };
    sprintScopeChange: { createMany: jest.Mock };
  };
  const handlers = new Map<string, (e: DomainEvent<never>) => Promise<void>>();

  function worklogsEvent(
    payload: Partial<PlanningWorklogsPayload>,
    tenantId = 'tenant-a',
  ): DomainEvent<PlanningWorklogsPayload> {
    return {
      type: EventTypes.PLANNING_WORKLOGS_OBSERVED,
      tenantId,
      connectionId: 'conn_1',
      sourceEventIds: ['raw_9'],
      occurredAt: new Date('2026-11-20T00:00:00.000Z'),
      payload: {
        externalKey: 'PAY-1',
        projectKey: 'PAY',
        complete: true,
        total: 1,
        worklogs: [
          {
            id: '501',
            authorLogin: 'acc-1',
            authorName: 'Asha Rao',
            started: '2026-11-20T09:30:00.000+0530',
            timeSpentSeconds: 5400,
          },
        ],
        ...payload,
      },
    };
  }

  function storyEvent(
    payload: Partial<PlanningStoryPayload>,
  ): DomainEvent<PlanningStoryPayload> {
    return {
      type: EventTypes.PLANNING_STORY_UPDATED,
      tenantId: 'tenant-a',
      connectionId: 'conn_1',
      sourceEventIds: ['raw_1'],
      occurredAt: new Date('2026-11-20T00:00:00.000Z'),
      payload: {
        externalKey: 'PAY-2',
        projectKey: 'PAY',
        status: 'To Do',
        title: 't',
        ...payload,
      },
    };
  }

  beforeEach(() => {
    handlers.clear();
    tx = {
      jiraWorklog: {
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      story: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma = {
      $transaction: jest.fn((fn: (t: typeof tx) => Promise<void>) => fn(tx)),
      story: { upsert: jest.fn().mockResolvedValue({}) },
      sprint: { upsert: jest.fn().mockResolvedValue({}) },
      release: { upsert: jest.fn().mockResolvedValue({}) },
      issueStatusHistory: { createMany: jest.fn().mockResolvedValue({}) },
      sprintScopeChange: { createMany: jest.fn().mockResolvedValue({}) },
    };
    const bus = {
      subscribe: jest.fn((type: string, fn: never) => handlers.set(type, fn)),
    } as unknown as EventBus;
    new PlanningService(prisma as unknown as PrismaService, bus).onModuleInit();
  });

  const handleWorklogs = (e: DomainEvent<PlanningWorklogsPayload>) =>
    handlers.get(EventTypes.PLANNING_WORKLOGS_OBSERVED)!(e as never);
  const handleStory = (e: DomainEvent<PlanningStoryPayload>) =>
    handlers.get(EventTypes.PLANNING_STORY_UPDATED)!(e as never);

  it('upserts each worklog tenant-scoped, keyed on the source id, with lineage', async () => {
    await handleWorklogs(worklogsEvent({}));

    expect(tx.jiraWorklog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_connectionId_sourceWorklogId: {
            tenantId: 'tenant-a',
            connectionId: 'conn_1',
            sourceWorklogId: '501',
          },
        },
        create: expect.objectContaining({
          tenantId: 'tenant-a',
          externalKey: 'PAY-1',
          timeSpentSeconds: 5400,
          startedAt: new Date('2026-11-20T04:00:00.000Z'),
          rawEventId: 'raw_9',
        }),
      }),
    );
  });

  it('a complete set deletes the issue’s absent worklogs and stamps the story', async () => {
    await handleWorklogs(worklogsEvent({}));

    expect(tx.jiraWorklog.deleteMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        connectionId: 'conn_1',
        externalKey: 'PAY-1',
        sourceWorklogId: { notIn: ['501'] },
      },
    });
    expect(tx.story.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', externalKey: 'PAY-1' },
      data: { worklogsCollectedAt: expect.any(Date) },
    });
  });

  it('an incomplete set never deletes and never stamps — a failed read must not erase logged time', async () => {
    await handleWorklogs(worklogsEvent({ complete: false, total: 40 }));

    expect(tx.jiraWorklog.upsert).toHaveBeenCalledTimes(1);
    expect(tx.jiraWorklog.deleteMany).not.toHaveBeenCalled();
    expect(tx.story.updateMany).not.toHaveBeenCalled();
  });

  it('an empty complete set clears the issue — every worklog was deleted in Jira', async () => {
    await handleWorklogs(worklogsEvent({ worklogs: [], total: 0 }));

    expect(tx.jiraWorklog.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        externalKey: 'PAY-1',
        sourceWorklogId: { notIn: [] },
      }),
    });
  });

  it('scopes the delete to the event’s tenant', async () => {
    await handleWorklogs(worklogsEvent({}, 'tenant-b'));
    expect(tx.jiraWorklog.deleteMany.mock.calls[0][0].where.tenantId).toBe(
      'tenant-b',
    );
  });

  it('stores the creator, and keeps a known one when a later event omits it', async () => {
    await handleStory(
      storyEvent({ creatorLogin: 'acc-7', creatorName: 'Asha Rao' }),
    );
    expect(prisma.story.upsert.mock.calls[0][0].update).toMatchObject({
      creatorLogin: 'acc-7',
      creatorName: 'Asha Rao',
    });

    await handleStory(storyEvent({}));
    const update = prisma.story.upsert.mock.calls[1][0].update;
    expect(update).not.toHaveProperty('creatorLogin');
    expect(update).not.toHaveProperty('creatorName');
  });
});
