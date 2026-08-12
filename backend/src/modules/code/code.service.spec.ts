import { CodePullRequestPayload } from '../../common/events/contracts';
import { DomainEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus';
import { EventTypes } from '../../common/events/event-types';
import { PrismaService } from '../../database/prisma.service';
import { CodeService } from './code.service';

describe('CodeService.listCommits', () => {
  it('windows by committedAt (not authoredAt) and orders by committedAt desc', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { commit: { findMany } } as unknown as PrismaService;
    const eventBus = { subscribe: jest.fn() } as unknown as EventBus;
    const service = new CodeService(prisma, eventBus);

    const from = new Date('2026-06-01T00:00:00.000Z');
    const to = new Date('2026-06-30T00:00:00.000Z');
    await service.listCommits('tenant-a', { from, to, authorLogin: 'jdoe' });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        authorLogin: 'jdoe',
        committedAt: { gte: from, lte: to },
      },
      orderBy: { committedAt: 'desc' },
      take: 2000,
    });
  });
});

describe('CodeService — PR commit messages', () => {
  function setup() {
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = {
      pullRequest: { upsert },
      commit: { upsert: jest.fn() },
    } as unknown as PrismaService;
    const handlers: ((
      e: DomainEvent<CodePullRequestPayload>,
    ) => Promise<void>)[] = [];
    const eventBus = {
      subscribe: jest.fn((_t: string, fn: never) => handlers.push(fn)),
    } as unknown as EventBus;
    const service = new CodeService(prisma, eventBus);
    service.onModuleInit();
    return { upsert, handle: handlers[0] };
  }

  function prEvent(
    payload: Partial<CodePullRequestPayload>,
  ): DomainEvent<CodePullRequestPayload> {
    return {
      type: EventTypes.CODE_PR_OPENED,
      tenantId: 'tenant-a',
      connectionId: 'conn_1',
      sourceEventIds: ['evt_1'],
      occurredAt: new Date('2026-06-05T00:00:00.000Z'),
      payload: {
        repoFullName: 'acme/payments',
        externalNumber: '4521',
        title: 'fix capture',
        branch: 'fix/capture',
        state: 'open',
        ...payload,
      },
    };
  }

  it('persists collected commit messages', async () => {
    const { upsert, handle } = setup();

    await handle(prEvent({ commitMessages: ['PAY-2231 guard capture'] }));

    const arg = upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.create.commitMessages).toEqual(['PAY-2231 guard capture']);
    expect(arg.update.commitMessages).toEqual(['PAY-2231 guard capture']);
  });

  it('never overwrites stored commit messages with an empty list', async () => {
    const { upsert, handle } = setup();

    // An event from a path that doesn't collect them (a webhook payload, or a
    // PR the enrich budget didn't reach). Writing [] here would silently
    // un-correlate the PR, and re-collecting costs a dedicated API call.
    await handle(prEvent({ commitMessages: [] }));

    const arg = upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.update).not.toHaveProperty('commitMessages');
    expect(arg.create.commitMessages).toEqual([]);
  });
});
