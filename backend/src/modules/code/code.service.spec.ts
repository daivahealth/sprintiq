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
    await service.listCommits('tenant-a', {
      from,
      to,
      authorLogins: ['jdoe'],
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        authorLogin: { in: ['jdoe'] },
        committedAt: { gte: from, lte: to },
      },
      orderBy: { committedAt: 'desc' },
      // limit + 1: the extra row is how the read knows it was truncated.
      take: 20_001,
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

describe('CodeService — Copilot usage projection (ADR-0012)', () => {
  function setup(existing: { collectedAt: Date } | null = null) {
    const usage = {
      findUnique: jest.fn().mockResolvedValue(existing),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockReturnValue('deleteMany'),
      findMany: jest.fn().mockResolvedValue([]),
    };
    const reportDay = {
      findUnique: jest.fn().mockResolvedValue(existing),
      upsert: jest.fn().mockReturnValue('upsert'),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    };
    const seat = {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          existing ? { observedAt: existing.collectedAt } : null,
        ),
      deleteMany: jest.fn().mockReturnValue('seatDelete'),
      createMany: jest.fn().mockReturnValue('seatCreate'),
      findMany: jest.fn().mockResolvedValue([]),
    };
    const $transaction = jest.fn().mockResolvedValue([]);
    const prisma = {
      copilotUsageDay: usage,
      copilotReportDay: reportDay,
      copilotSeat: seat,
      $transaction,
    } as unknown as PrismaService;
    const handlers = new Map<
      string,
      (e: DomainEvent<never>) => Promise<void>
    >();
    const eventBus = {
      subscribe: jest.fn((t: string, fn: never) => handlers.set(t, fn)),
    } as unknown as EventBus;
    const service = new CodeService(prisma, eventBus);
    service.onModuleInit();
    return { service, usage, reportDay, seat, $transaction, handlers };
  }

  function event<T>(type: string, payload: T): DomainEvent<never> {
    return {
      type,
      tenantId: 'tenant-a',
      connectionId: 'cfg_1',
      sourceEventIds: ['raw_1'],
      occurredAt: new Date('2026-10-12T00:00:00Z'),
      payload: payload as never,
    };
  }

  const usagePayload = {
    org: 'acme',
    day: '2026-10-12',
    githubUserId: 42,
    login: 'asha',
    interactions: 7,
    generations: 20,
    acceptances: 9,
    locSuggestedAdd: 300,
    locSuggestedDelete: 10,
    locAdded: 120,
    locDeleted: 4,
    usedAgent: true,
    usedChat: true,
    usedCli: false,
    usedCodingAgent: false,
    aiCreditsUsed: null,
    collectedAt: '2026-10-15T04:30:00.000Z',
    record: {},
  };

  it('upserts a user-day keyed by tenant, org, day and GitHub user id', async () => {
    const { usage, handlers } = setup();
    await handlers.get(EventTypes.CODE_COPILOT_USAGE_REPORTED)!(
      event(EventTypes.CODE_COPILOT_USAGE_REPORTED, usagePayload),
    );
    expect(usage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_org_day_githubUserId: {
            tenantId: 'tenant-a',
            org: 'acme',
            day: new Date('2026-10-12T00:00:00.000Z'),
            githubUserId: BigInt(42),
          },
        },
        update: expect.objectContaining({ locAdded: 120, rawEventId: 'raw_1' }),
      }),
    );
  });

  it('ignores a replay older than the stored reading (last-wins)', async () => {
    const { usage, handlers } = setup({
      collectedAt: new Date('2026-10-16T04:30:00.000Z'),
    });
    await handlers.get(EventTypes.CODE_COPILOT_USAGE_REPORTED)!(
      event(EventTypes.CODE_COPILOT_USAGE_REPORTED, usagePayload),
    );
    expect(usage.upsert).not.toHaveBeenCalled();
  });

  it('a report-day marker drops users the restated report no longer lists', async () => {
    const { usage, $transaction, handlers } = setup();
    await handlers.get(EventTypes.CODE_COPILOT_REPORT_DAY_COLLECTED)!(
      event(EventTypes.CODE_COPILOT_REPORT_DAY_COLLECTED, {
        org: 'acme',
        day: '2026-10-12',
        userCount: 1,
        githubUserIds: [42],
        collectedAt: '2026-10-15T04:30:00.000Z',
      }),
    );
    expect(usage.deleteMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        org: 'acme',
        day: new Date('2026-10-12T00:00:00.000Z'),
        githubUserId: { notIn: [BigInt(42)] },
      },
    });
    expect($transaction).toHaveBeenCalledWith(['upsert', 'deleteMany']);
  });

  it('replaces the seat snapshot whole, within the tenant', async () => {
    const { seat, $transaction, handlers } = setup();
    await handlers.get(EventTypes.CODE_COPILOT_SEATS_OBSERVED)!(
      event(EventTypes.CODE_COPILOT_SEATS_OBSERVED, {
        org: 'acme',
        observedAt: '2026-10-15T04:30:00.000Z',
        seats: [{ githubUserId: 42, login: 'asha' }],
      }),
    );
    expect(seat.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', org: 'acme' },
    });
    expect(seat.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({ tenantId: 'tenant-a', login: 'asha' }),
        ],
      }),
    );
    expect($transaction).toHaveBeenCalledWith(['seatDelete', 'seatCreate']);
  });

  it('every read is scoped to the asking tenant', async () => {
    // Tenant isolation: the reads take the tenant as their first predicate, so
    // tenant B's rows can never satisfy a tenant A query.
    const { service, usage, reportDay, seat } = setup();
    await service.copilotUsageRows('tenant-a', '2026-10-01', '2026-10-14');
    await service.copilotSeatLogins('tenant-a');
    await service.copilotCoverage('tenant-a', '2026-10-01', '2026-10-14');
    for (const call of [
      ...usage.findMany.mock.calls,
      ...seat.findMany.mock.calls,
      ...reportDay.findFirst.mock.calls,
      ...reportDay.count.mock.calls,
    ]) {
      expect((call[0] as { where: { tenantId: string } }).where.tenantId).toBe(
        'tenant-a',
      );
    }
    expect(usage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-a',
          day: {
            gte: new Date('2026-10-01T00:00:00.000Z'),
            lte: new Date('2026-10-14T00:00:00.000Z'),
          },
        },
      }),
    );
  });

  it('reports "never collected" distinctly from "collected, through a day"', async () => {
    const { service, reportDay } = setup();
    await expect(
      service.copilotCoverage('tenant-a', '2026-10-01', '2026-10-14'),
    ).resolves.toEqual({
      collected: false,
      coveredThrough: null,
      reportDaysInWindow: 0,
    });
    reportDay.findFirst.mockResolvedValue({
      day: new Date('2026-10-13T00:00:00.000Z'),
    });
    reportDay.count.mockResolvedValue(13);
    await expect(
      service.copilotCoverage('tenant-a', '2026-10-01', '2026-10-14'),
    ).resolves.toEqual({
      collected: true,
      coveredThrough: '2026-10-13',
      reportDaysInWindow: 13,
    });
  });
});
