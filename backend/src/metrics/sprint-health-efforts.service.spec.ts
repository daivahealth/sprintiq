import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { CorrelationService } from '../correlation/correlation.service';
import { DeveloperIdentityService } from '../correlation/developer-identity.service';
import { PrismaService } from '../database/prisma.service';
import { CodeService } from '../modules/code/code.service';
import { PlanningService } from '../modules/planning/planning.service';
import { SprintHealthDetailService } from './sprint-health-detail.service';

/**
 * `SprintHealthDetailService.efforts` (ADR-0014) — the data-loading half.
 * The roster and bucketing rules are covered by sprint-efforts.spec; this
 * file pins what is READ: tenant scope, the sprint's item set, and the window.
 */
describe('SprintHealthDetailService.efforts', () => {
  let prisma: {
    trackedDeveloper: { findMany: jest.Mock };
    watchlistExclusion: { findMany: jest.Mock };
    story: { findMany: jest.Mock };
    jiraWorklog: { findMany: jest.Mock };
  };
  let identities: jest.Mocked<DeveloperIdentityService>;
  let planning: jest.Mocked<PlanningService>;
  let service: SprintHealthDetailService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-31T00:00:00.000Z'));
    planning = {
      findSprintByExternalId: jest.fn(async (tenantId: string, id: string) =>
        tenantId === 't1' && id === '42'
          ? {
              id: 'sprint-1',
              externalId: '42',
              startAt: new Date('2026-08-25T04:30:00.000Z'), // 10:00 IST
              endAt: new Date('2026-09-05T00:00:00.000Z'),
            }
          : null,
      ),
      listItemsForSprint: jest.fn().mockResolvedValue([
        {
          externalKey: 'ACT-1',
          type: 'story',
          worklogsCollectedAt: new Date(),
        },
        { externalKey: 'ACT-2', type: 'story', worklogsCollectedAt: null },
      ]),
    } as unknown as jest.Mocked<PlanningService>;
    identities = {
      attributionIndex: jest.fn().mockResolvedValue({
        byLogin: new Map(),
        byEmail: new Map(),
        displayNames: new Map([['asha', 'Asha Rao']]),
        excluded: new Set(),
      }),
      jiraAssigneeIndex: jest.fn().mockResolvedValue({
        byDeveloper: new Map([['asha', { logins: ['acc-asha'], names: [] }]]),
        assignees: { observed: 1, matched: 1, unmatched: 0 },
      }),
      resolveJiraPeople: jest
        .fn()
        .mockResolvedValue(
          new Map([['login:acc-asha', { developer: 'asha', excluded: false }]]),
        ),
    } as unknown as jest.Mocked<DeveloperIdentityService>;
    prisma = {
      trackedDeveloper: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ canonicalDeveloperId: 'asha' }]),
      },
      watchlistExclusion: { findMany: jest.fn().mockResolvedValue([]) },
      story: {
        findMany: jest.fn().mockResolvedValue([
          {
            externalKey: 'ACT-9',
            type: 'subtask',
            parentKey: 'ACT-1',
            creatorLogin: 'acc-asha',
            creatorName: 'Asha Rao',
            sourceCreatedAt: new Date('2026-08-25T06:00:00.000Z'),
            worklogsCollectedAt: null,
          },
        ]),
      },
      jiraWorklog: {
        findMany: jest.fn().mockResolvedValue([
          {
            authorLogin: 'acc-asha',
            authorName: 'Asha Rao',
            authorEmail: null,
            // 09:00 IST on day one — before the sprint's 10:00 start, still day one.
            startedAt: new Date('2026-08-25T03:30:00.000Z'),
            timeSpentSeconds: 3600,
          },
        ]),
      },
    };
    service = new SprintHealthDetailService(
      {
        requireTenantId: jest.fn().mockReturnValue('t1'),
      } as unknown as TenantContextService,
      prisma as unknown as PrismaService,
      planning,
      {} as unknown as CodeService,
      identities,
      {} as unknown as CorrelationService,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('returns null for a sprint the tenant does not have', async () => {
    expect(await service.efforts('nope')).toBeNull();
  });

  it('reads every table for the calling tenant only', async () => {
    await service.efforts('42');
    expect(
      prisma.trackedDeveloper.findMany.mock.calls[0][0].where,
    ).toMatchObject({
      tenantId: 't1',
      active: true,
    });
    expect(
      prisma.watchlistExclusion.findMany.mock.calls[0][0].where.tenantId,
    ).toBe('t1');
    expect(prisma.story.findMany.mock.calls[0][0].where.tenantId).toBe('t1');
    expect(prisma.jiraWorklog.findMany.mock.calls[0][0].where.tenantId).toBe(
      't1',
    );
    expect(identities.resolveJiraPeople.mock.calls[0][0]).toBe('t1');
  });

  it('scopes to the sprint’s items plus their subtasks, and reads worklogs by whole IST days', async () => {
    const view = await service.efforts('42');

    expect(prisma.story.findMany.mock.calls[0][0].where).toMatchObject({
      type: 'subtask',
      parentKey: { in: ['ACT-1', 'ACT-2'] },
    });
    const where = prisma.jiraWorklog.findMany.mock.calls[0][0].where;
    expect(where.externalKey.in.sort()).toEqual(['ACT-1', 'ACT-2', 'ACT-9']);
    // From IST midnight of the first day, not the sprint's 10:00 start.
    expect(where.startedAt.gte).toEqual(new Date('2026-08-24T18:30:00.000Z'));

    expect(view!.rows).toEqual([
      expect.objectContaining({
        developer: 'asha',
        jiraLinked: true,
        effortSeconds: [3600, 0, 0, 0, 0, 0, 0],
      }),
    ]);
    expect(view!.disclosures).toMatchObject({
      itemsInScope: 3,
      itemsWithoutWorklogSnapshot: 2,
    });
  });

  it('suppresses a live Watchlist exclusion like the digest does', async () => {
    prisma.watchlistExclusion.findMany.mockResolvedValue([
      { canonicalDeveloperId: 'asha' },
    ]);
    const view = await service.efforts('42');
    expect(view!.rows).toEqual([]);
    expect(view!.roster.suppressed).toBe(1);
  });
});
