import { Sprint } from '@prisma/client';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { CorrelationService } from '../correlation/correlation.service';
import { DeveloperIdentityService } from '../correlation/developer-identity.service';
import { CodeService } from '../modules/code/code.service';
import { PlanningService } from '../modules/planning/planning.service';
import { ConnectionsService } from '../modules/connections/connections.service';
import { InsightsService } from './insights.service';

const NOW = new Date('2026-08-14T00:00:00.000Z');

function sprint(overrides: Partial<Sprint>): Sprint {
  return {
    externalId: 's1',
    name: 'Sprint 1',
    state: 'active',
    projectKey: 'PAY',
    startAt: new Date('2026-08-01T00:00:00.000Z'),
    endAt: new Date('2026-08-30T00:00:00.000Z'),
    ...overrides,
  } as Sprint;
}

/** No collection horizon — this suite is about sprint state, not data depth. */
function horizonStub(): ConnectionsService {
  return {
    getDataHorizon: jest.fn().mockResolvedValue({}),
  } as unknown as ConnectionsService;
}

describe('InsightsService — sprints Jira still calls active', () => {
  let planning: jest.Mocked<PlanningService>;
  let service: InsightsService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    planning = {
      listSprints: jest.fn(),
      listItemsForSprint: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<PlanningService>;
    service = new InsightsService(
      {
        requireTenantId: jest.fn().mockReturnValue('tenant-a'),
      } as unknown as TenantContextService,
      planning,
      {
        listPullRequestsByRefs: jest.fn().mockResolvedValue([]),
      } as unknown as CodeService,
      {
        prRefsByStoryId: jest.fn().mockResolvedValue(new Map()),
      } as unknown as CorrelationService,
      {} as unknown as DeveloperIdentityService,
      horizonStub(),
    );
  });

  afterEach(() => jest.useRealTimers());

  it('keeps a genuinely running sprint in the ranked cards', async () => {
    planning.listSprints.mockResolvedValue([sprint({})]);

    const view = await service.activeSprintsHealth([]);

    expect(view.rows).toHaveLength(1);
    expect(view.stale).toHaveLength(0);
  });

  it('tolerates a sprint running a few days past its end date', async () => {
    // Overrunning slightly is ordinary practice, not abandonment — the grace
    // period exists so a normal overrun isn't reported as a data problem.
    planning.listSprints.mockResolvedValue([
      sprint({ endAt: new Date('2026-08-09T00:00:00.000Z') }),
    ]);

    const view = await service.activeSprintsHealth([]);

    expect(view.rows).toHaveLength(1);
    expect(view.stale).toHaveLength(0);
  });

  it('separates a sprint abandoned years ago, and reports how stale it is', async () => {
    // The real case: Jira never auto-closes a sprint, so a team that stopped
    // using a board leaves its last one "active" forever. It is 100% elapsed,
    // so pace-ranking always floated it above the sprint needing attention.
    planning.listSprints.mockResolvedValue([
      sprint({
        externalId: 'live',
        name: 'Sprint-26-8',
      }),
      sprint({
        externalId: 'abandoned',
        name: 'Jan-March 2022',
        projectKey: 'DMO',
        startAt: new Date('2022-01-01T00:00:00.000Z'),
        endAt: new Date('2022-03-30T00:00:00.000Z'),
      }),
    ]);

    const view = await service.activeSprintsHealth([]);

    expect(view.rows.map((r) => r.sprint.externalId)).toEqual(['live']);
    expect(view.stale).toHaveLength(1);
    expect(view.stale[0].sprint.name).toBe('Jan-March 2022');
    expect(view.stale[0].daysPastEnd).toBeGreaterThan(1000);
  });

  it('never calls a sprint stale when it has no end date to be past', async () => {
    planning.listSprints.mockResolvedValue([sprint({ endAt: null })]);

    const view = await service.activeSprintsHealth([]);

    expect(view.stale).toHaveLength(0);
    expect(view.rows).toHaveLength(1);
  });

  it('applies the same split to Sprint Risk', async () => {
    planning.listSprints.mockResolvedValue([
      sprint({ externalId: 'live' }),
      sprint({
        externalId: 'abandoned',
        endAt: new Date('2022-03-30T00:00:00.000Z'),
      }),
    ]);

    const view = await service.activeSprintsRisk([]);

    expect(view.rows.map((r) => r.sprint.externalId)).toEqual(['live']);
    expect(view.stale).toHaveLength(1);
  });
});
