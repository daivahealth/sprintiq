import { Sprint, Story } from '@prisma/client';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { CorrelationService } from '../correlation/correlation.service';
import { DeveloperIdentityService } from '../correlation/developer-identity.service';
import { CodeService } from '../modules/code/code.service';
import { PlanningService } from '../modules/planning/planning.service';
import { ConnectionsService } from '../modules/connections/connections.service';
import { InsightsService } from './insights.service';

const NOW = new Date('2026-08-14T00:00:00.000Z');

function sprint(over: Partial<Sprint>): Sprint {
  return {
    externalId: 's',
    name: 'Sprint',
    state: 'closed',
    projectKey: 'ACT',
    startAt: new Date('2026-07-01T00:00:00.000Z'),
    endAt: new Date('2026-07-31T00:00:00.000Z'),
    ...over,
  } as Sprint;
}

function item(storyPoints: number | null, status = 'Done'): Story {
  return { type: 'story', status, storyPoints } as Story;
}

/** Horizon stub — pass a date to simulate a collection floor. */
function horizonStub(jira?: string): ConnectionsService {
  return {
    getDataHorizon: jest.fn().mockResolvedValue(jira ? { jira } : {}),
  } as unknown as ConnectionsService;
}

describe('InsightsService.velocity', () => {
  let planning: jest.Mocked<PlanningService>;
  let service: InsightsService;
  let itemsBySprint: Record<string, Story[]>;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    itemsBySprint = {};
    planning = {
      listSprints: jest.fn(),
      listItemsForSprint: jest
        .fn()
        .mockImplementation(
          async (_t: string, id: string) => itemsBySprint[id] ?? [],
        ),
    } as unknown as jest.Mocked<PlanningService>;
    service = new InsightsService(
      { requireTenantId: () => 'tenant-a' } as unknown as TenantContextService,
      planning,
      {} as unknown as CodeService,
      {} as unknown as CorrelationService,
      {} as unknown as DeveloperIdentityService,
      horizonStub(),
    );
  });

  afterEach(() => jest.useRealTimers());

  it('groups by project instead of pooling unrelated sprints into one series', async () => {
    // The reported symptom: six bars spanning five projects read as one
    // sequence, inviting comparison between teams estimating on different
    // scales.
    planning.listSprints.mockResolvedValue([
      sprint({ externalId: 'a1', projectKey: 'ACT' }),
      sprint({ externalId: 'd1', projectKey: 'DPP' }),
      sprint({ externalId: 'a2', projectKey: 'ACT' }),
    ]);

    const groups = await service.velocity([]);

    expect(groups.map((g) => g.projectKey).sort()).toEqual(['ACT', 'DPP']);
    expect(groups.find((g) => g.projectKey === 'ACT')!.rows).toHaveLength(2);
  });

  it('leads each project with the running sprint, then closed ones newest-first', async () => {
    planning.listSprints.mockResolvedValue([
      sprint({
        externalId: 'old',
        name: 'older',
        endAt: new Date('2026-05-31T00:00:00.000Z'),
      }),
      sprint({
        externalId: 'live',
        name: 'running',
        state: 'active',
        endAt: new Date('2026-08-30T00:00:00.000Z'),
      }),
      sprint({
        externalId: 'recent',
        name: 'recent',
        endAt: new Date('2026-07-31T00:00:00.000Z'),
      }),
    ]);

    const [group] = await service.velocity([]);

    expect(group.rows.map((r) => r.sprint.name)).toEqual([
      'running',
      'recent',
      'older',
    ]);
    expect(group.rows[0].inProgress).toBe(true);
  });

  it('never averages the running sprint into velocity', async () => {
    // A sprint halfway through has completed half its work by definition;
    // averaging it in makes velocity depend on what day you open the page.
    planning.listSprints.mockResolvedValue([
      sprint({ externalId: 'live', state: 'active' }),
      sprint({ externalId: 'done1' }),
      sprint({ externalId: 'done2' }),
    ]);
    itemsBySprint = {
      live: [item(5), item(5, 'In Progress')], // 5 of 10 completed so far
      done1: [item(10), item(10)], // 20
      done2: [item(10), item(10)], // 20
    };

    const [group] = await service.velocity([]);

    expect(group.closedSprintsSampled).toBe(2);
    expect(group.avgCompletedPoints).toBe(20);
  });

  it('reports estimate coverage and refuses to call points reliable below the floor', async () => {
    // The production case: most items unestimated, and the ones being
    // completed are precisely those — so completed points reads near-zero
    // while most of the sprint was actually finished.
    planning.listSprints.mockResolvedValue([sprint({ externalId: 's1' })]);
    itemsBySprint = {
      s1: [
        item(null), // done, no estimate
        item(null), // done, no estimate
        item(null), // done, no estimate
        item(100, 'In Progress'), // estimated, not done
      ],
    };

    const [group] = await service.velocity([]);
    const row = group.rows[0];

    expect(row.itemsDone).toBe(3);
    expect(row.itemsTotal).toBe(4);
    expect(row.unestimatedItems).toBe(3);
    expect(row.estimateCoveragePct).toBe(25);
    expect(row.completedPoints).toBe(0); // the misleading headline
    expect(group.pointsReliable).toBe(false);
    // Throughput still describes the sprint honestly.
    expect(group.avgCompletedItems).toBe(3);
  });

  it('trusts points when the work is actually estimated', async () => {
    planning.listSprints.mockResolvedValue([sprint({ externalId: 's1' })]);
    itemsBySprint = {
      s1: [item(5), item(5), item(3, 'In Progress'), item(2)],
    };

    const [group] = await service.velocity([]);

    expect(group.rows[0].estimateCoveragePct).toBe(100);
    expect(group.pointsReliable).toBe(true);
    expect(group.avgCompletedPoints).toBe(12);
  });

  it('excludes a sprint nobody estimated from the average rather than counting it as zero', async () => {
    // Otherwise a team reads as slowing down when all that changed is that
    // they stopped estimating.
    planning.listSprints.mockResolvedValue([
      sprint({ externalId: 'estimated' }),
      sprint({ externalId: 'unestimated' }),
    ]);
    itemsBySprint = {
      estimated: [item(10)],
      unestimated: [item(null), item(null)],
    };

    const [group] = await service.velocity([]);

    expect(group.avgCompletedPoints).toBe(10);
  });

  it('shows sprints older than the collection floor but never averages them', async () => {
    // The production failure this guards: Jira collects `updated >= floor`, so
    // a sprint that closed earlier holds only the few items touched since.
    // Averaging those hollow sprints dragged ACT's reported velocity from 475
    // items per sprint to 241, and made Velocity and Forecasting disagree by 2x
    // purely because one sampled across the floor and the other didn't.
    planning.listSprints.mockResolvedValue([
      sprint({
        externalId: 'recent',
        endAt: new Date('2026-07-31T00:00:00.000Z'),
      }),
      sprint({
        externalId: 'hollow',
        endAt: new Date('2025-08-30T00:00:00.000Z'),
      }),
    ]);
    itemsBySprint = {
      recent: [item(10), item(10), item(10)], // 3 items, all done
      hollow: [item(10)], // looks like a 1-item sprint; it wasn't
    };
    service = new InsightsService(
      { requireTenantId: () => 'tenant-a' } as unknown as TenantContextService,
      planning,
      {} as unknown as CodeService,
      {} as unknown as CorrelationService,
      {} as unknown as DeveloperIdentityService,
      horizonStub('2026-05-13T00:00:00.000Z'),
    );

    const [group] = await service.velocity([]);

    // Both are visible — the old sprint is real and hiding it would be its own
    // kind of lie — but only the one inside the window feeds the average.
    expect(group.rows).toHaveLength(2);
    expect(
      group.rows.find((r) => r.sprint.externalId === 'hollow')!.beyondHorizon,
    ).toBe(true);
    expect(group.closedSprintsSampled).toBe(1);
    expect(group.sprintsBeyondHorizon).toBe(1);
    expect(group.avgCompletedItems).toBe(3); // not (3+1)/2 = 2
  });

  it('leaves out future and long-abandoned sprints', async () => {
    planning.listSprints.mockResolvedValue([
      sprint({ externalId: 'real' }),
      sprint({
        externalId: 'planned',
        state: 'future',
        startAt: null,
        endAt: null,
      }),
      sprint({
        externalId: 'abandoned',
        state: 'active',
        endAt: new Date('2022-03-30T00:00:00.000Z'),
      }),
    ]);

    const [group] = await service.velocity([]);

    expect(group.rows.map((r) => r.sprint.externalId)).toEqual(['real']);
  });
});

describe('InsightsService.forecast', () => {
  let planning: jest.Mocked<PlanningService>;
  let service: InsightsService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    planning = {
      listSprints: jest.fn().mockResolvedValue([sprint({ externalId: 's1' })]),
      listItemsForSprint: jest
        .fn()
        .mockResolvedValue([
          item(null),
          item(null),
          item(null),
          item(50, 'In Progress'),
        ]),
      listOpenBacklog: jest
        .fn()
        .mockResolvedValue([
          item(50, 'To Do'),
          item(null, 'To Do'),
          item(null, 'To Do'),
        ]),
      listProjectKeys: jest.fn().mockResolvedValue(['ACT']),
    } as unknown as jest.Mocked<PlanningService>;
    service = new InsightsService(
      { requireTenantId: () => 'tenant-a' } as unknown as TenantContextService,
      planning,
      {} as unknown as CodeService,
      {} as unknown as CorrelationService,
      {} as unknown as DeveloperIdentityService,
      horizonStub(),
    );
  });

  afterEach(() => jest.useRealTimers());

  it('offers an item projection and flags the points one as unusable at low coverage', async () => {
    // On real data the points path produced ~180 sprints (about 18 years)
    // purely because the completed work was the unestimated work, while the
    // item path on the same data came out at 7.
    const [f] = await service.forecast(['ACT']);

    expect(f.pointsReliable).toBe(false);
    expect(f.estimateCoveragePct).toBe(25);
    // Items: 3 completed per sprint, 3 remaining → 1 sprint.
    expect(f.avgVelocityItems).toBe(3);
    expect(f.sprintsNeededByItems).toBe(1);
    expect(f.projectedDateByItems).not.toBeNull();
  });
});
