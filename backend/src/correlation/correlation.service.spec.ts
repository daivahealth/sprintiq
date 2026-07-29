import { EventBus } from '../common/events/event-bus';
import { PrismaService } from '../database/prisma.service';
import { PlanningService } from '../modules/planning/planning.service';
import { CorrelationService } from './correlation.service';

function orphan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'orphan_1',
    tenantId: 'tenant-a',
    nodeType: 'pull_request',
    nodeRef: 'athmahealth/api#42',
    reason: 'unknown_project',
    resolvedAt: null,
    ...overrides,
  };
}

function pr(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pr_1',
    tenantId: 'tenant-a',
    repoFullName: 'athmahealth/api',
    externalNumber: '42',
    title: 'ACT-1234 fix bug',
    branch: 'feature/ACT-1234',
    commitMessages: [] as string[],
    ...overrides,
  };
}

describe('CorrelationService.reconcileOrphans', () => {
  let prisma: {
    orphan: { findMany: jest.Mock; update: jest.Mock };
    pullRequest: { findUnique: jest.Mock };
    correlationLink: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let planning: jest.Mocked<PlanningService>;
  let service: CorrelationService;

  beforeEach(() => {
    prisma = {
      orphan: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
      pullRequest: {
        findUnique: jest.fn(),
      },
      correlationLink: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    planning = {
      findByKey: jest.fn(),
    } as unknown as jest.Mocked<PlanningService>;
    const eventBus = { subscribe: jest.fn() } as unknown as EventBus;
    service = new CorrelationService(
      prisma as unknown as PrismaService,
      eventBus,
      planning,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('links and resolves an orphan whose story now exists (Jira data arrived after PR ingestion)', async () => {
    prisma.orphan.findMany.mockResolvedValue([orphan()]);
    prisma.pullRequest.findUnique.mockResolvedValue(pr());
    planning.findByKey.mockResolvedValue({ id: 'story_1' } as never);

    const result = await service.reconcileOrphans('tenant-a');

    expect(result).toEqual({ candidates: 1, resolved: 1, stillOrphaned: 0 });
    expect(prisma.correlationLink.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          edgeType: 'pr_implements_story',
          fromId: 'athmahealth/api#42',
          toId: 'story_1',
        }),
      }),
    );
    expect(prisma.orphan.update).toHaveBeenCalledWith({
      where: { id: 'orphan_1' },
      data: { resolvedAt: expect.any(Date) },
    });
  });

  it('leaves an orphan unresolved when its story still does not exist', async () => {
    prisma.orphan.findMany.mockResolvedValue([orphan()]);
    prisma.pullRequest.findUnique.mockResolvedValue(pr());
    planning.findByKey.mockResolvedValue(null);

    const result = await service.reconcileOrphans('tenant-a');

    expect(result).toEqual({ candidates: 1, resolved: 0, stillOrphaned: 1 });
    expect(prisma.correlationLink.create).not.toHaveBeenCalled();
    expect(prisma.orphan.update).not.toHaveBeenCalled();
  });

  it('leaves an orphan unresolved when the PR has no Jira key at all', async () => {
    prisma.orphan.findMany.mockResolvedValue([orphan()]);
    prisma.pullRequest.findUnique.mockResolvedValue(
      pr({ title: 'fix bug', branch: 'main' }),
    );

    const result = await service.reconcileOrphans('tenant-a');

    expect(result).toMatchObject({ resolved: 0, stillOrphaned: 1 });
    expect(planning.findByKey).not.toHaveBeenCalled();
  });

  it('counts as still-orphaned (not a crash) when the underlying PR row is gone', async () => {
    prisma.orphan.findMany.mockResolvedValue([orphan()]);
    prisma.pullRequest.findUnique.mockResolvedValue(null);

    const result = await service.reconcileOrphans('tenant-a');

    expect(result).toEqual({ candidates: 1, resolved: 0, stillOrphaned: 1 });
  });

  it('queries only unresolved pull_request orphans for the tenant', async () => {
    prisma.orphan.findMany.mockResolvedValue([]);

    await service.reconcileOrphans('tenant-a');

    expect(prisma.orphan.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        nodeType: 'pull_request',
        resolvedAt: null,
      },
      take: 500,
    });
  });
});
