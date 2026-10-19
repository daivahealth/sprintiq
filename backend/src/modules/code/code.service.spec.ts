import {
  CodeCommitBranchObservedPayload,
  CodeCommitPayload,
  CodePullRequestPayload,
} from '../../common/events/contracts';
import { DomainEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus';
import { EventTypes } from '../../common/events/event-types';
import { PrismaService } from '../../database/prisma.service';
import { branchKey, CodeService } from './code.service';

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

describe('CodeService — commit parent count', () => {
  function setup() {
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = {
      pullRequest: { upsert: jest.fn() },
      commit: { upsert },
    } as unknown as PrismaService;
    const handlers = new Map<
      string,
      (e: DomainEvent<CodeCommitPayload>) => Promise<void>
    >();
    const eventBus = {
      subscribe: jest.fn((t: string, fn: never) => handlers.set(t, fn)),
    } as unknown as EventBus;
    new CodeService(prisma, eventBus).onModuleInit();
    return { upsert, handle: handlers.get(EventTypes.CODE_COMMIT_PUSHED)! };
  }

  const event = (
    payload: Partial<CodeCommitPayload>,
  ): DomainEvent<CodeCommitPayload> => ({
    type: EventTypes.CODE_COMMIT_PUSHED,
    tenantId: 'tenant-a',
    connectionId: 'conn_1',
    sourceEventIds: ['evt_1'],
    occurredAt: new Date('2026-10-14T05:00:00.000Z'),
    payload: {
      repoFullName: 'acme/payments',
      sha: 'abc123',
      message: 'Merge pull request #7',
      authoredAt: '2026-10-14T05:00:00.000Z',
      ...payload,
    },
  });

  it('stores the parent count when the event carries one', async () => {
    const { upsert, handle } = setup();
    await handle(event({ parentCount: 2 }));
    const arg = upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.create.parentCount).toBe(2);
    expect(arg.update.parentCount).toBe(2);
  });

  it('never nulls a known parent count from an event that lacks one (a push webhook)', async () => {
    const { upsert, handle } = setup();
    await handle(event({}));
    const arg = upsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(arg.update).not.toHaveProperty('parentCount');
  });
});

describe('CodeService — branch tracking', () => {
  function setup() {
    const commitBranch = {
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    };
    const pullRequest = { findMany: jest.fn().mockResolvedValue([]) };
    const prisma = {
      commitBranch,
      pullRequest,
      commit: { upsert: jest.fn() },
    } as unknown as PrismaService;
    const handlers = new Map<
      string,
      (e: DomainEvent<CodeCommitBranchObservedPayload>) => Promise<void>
    >();
    const eventBus = {
      subscribe: jest.fn((t: string, fn: never) => handlers.set(t, fn)),
    } as unknown as EventBus;
    const service = new CodeService(prisma, eventBus);
    service.onModuleInit();
    return {
      service,
      commitBranch,
      pullRequest,
      handle: handlers.get(EventTypes.CODE_COMMIT_BRANCH_OBSERVED)!,
    };
  }

  const event = (
    observedAt: string,
  ): DomainEvent<CodeCommitBranchObservedPayload> => ({
    type: EventTypes.CODE_COMMIT_BRANCH_OBSERVED,
    tenantId: 'tenant-a',
    connectionId: 'conn_1',
    sourceEventIds: ['evt_1'],
    occurredAt: new Date(observedAt),
    payload: {
      repoFullName: 'acme/ehr',
      branch: 'feat-x',
      sha: 'abc',
      observedAt,
    },
  });

  it('creates the link once, tenant-scoped, and only ever moves firstSeenAt earlier', async () => {
    const { handle, commitBranch } = setup();
    await handle(event('2026-10-19T05:00:00.000Z'));
    const key = {
      tenantId: 'tenant-a',
      repoFullName: 'acme/ehr',
      branch: 'feat-x',
      sha: 'abc',
    };
    expect(commitBranch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_repoFullName_branch_sha: key },
        create: expect.objectContaining({
          ...key,
          firstSeenAt: new Date('2026-10-19T05:00:00.000Z'),
        }),
        update: {},
      }),
    );
    expect(commitBranch.updateMany).toHaveBeenCalledWith({
      where: {
        ...key,
        firstSeenAt: { gt: new Date('2026-10-19T05:00:00.000Z') },
      },
      data: { firstSeenAt: new Date('2026-10-19T05:00:00.000Z') },
    });
  });

  it('reads branch links per repo, tenant-scoped, and none for no commits', async () => {
    const { service, commitBranch } = setup();
    expect(await service.branchesForCommits('tenant-a', [])).toEqual([]);
    expect(commitBranch.findMany).not.toHaveBeenCalled();
    await service.branchesForCommits('tenant-a', [
      { repoFullName: 'acme/ehr', sha: 'a' },
      { repoFullName: 'acme/ehr', sha: 'b' },
      { repoFullName: 'acme/lab', sha: 'c' },
    ]);
    expect(commitBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-a',
          OR: [
            { repoFullName: 'acme/ehr', sha: { in: ['a', 'b'] } },
            { repoFullName: 'acme/lab', sha: { in: ['c'] } },
          ],
        },
      }),
    );
  });

  it('labels a branch merged over open over closed', async () => {
    const { service, pullRequest } = setup();
    pullRequest.findMany.mockResolvedValue([
      { repoFullName: 'acme/ehr', branch: 'x', state: 'closed' },
      { repoFullName: 'acme/ehr', branch: 'x', state: 'merged' },
      { repoFullName: 'acme/ehr', branch: 'y', state: 'closed' },
      { repoFullName: 'acme/ehr', branch: 'y', state: 'open' },
      { repoFullName: 'acme/ehr', branch: 'z', state: 'closed' },
    ]);
    const m = await service.pullStatusByBranch('tenant-a', [
      { repoFullName: 'acme/ehr', branch: 'x' },
      { repoFullName: 'acme/ehr', branch: 'y' },
      { repoFullName: 'acme/ehr', branch: 'z' },
    ]);
    expect(m.get(branchKey('acme/ehr', 'x'))).toBe('merged');
    expect(m.get(branchKey('acme/ehr', 'y'))).toBe('open');
    expect(m.get(branchKey('acme/ehr', 'z'))).toBe('closed');
    expect(pullRequest.findMany.mock.calls[0][0].where.tenantId).toBe(
      'tenant-a',
    );
  });
});
