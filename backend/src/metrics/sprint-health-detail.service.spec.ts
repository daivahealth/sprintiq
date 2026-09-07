import { DeveloperIdentityService } from '../correlation/developer-identity.service';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { PrismaService } from '../database/prisma.service';
import { CodeService } from '../modules/code/code.service';
import { PlanningService } from '../modules/planning/planning.service';
import { InsightsService } from './insights.service';
import { SprintHealthDetailService } from './sprint-health-detail.service';

/** The sprint every test resolves '42' to, unless a test overrides the mock. */
function defaultSprint() {
  return {
    id: 'sprint-1',
    tenantId: 't1',
    connectionId: 'conn-1',
    externalId: '42',
    name: 'ACT Sprint 12',
    state: 'active',
    projectKey: 'ACT',
    startAt: new Date('2026-08-25T00:00:00.000Z'),
    endAt: new Date('2026-09-05T00:00:00.000Z'),
    goal: null,
    createdAt: new Date('2026-08-25T00:00:00.000Z'),
    updatedAt: new Date('2026-08-25T00:00:00.000Z'),
  };
}

/** 14 commits across exactly 2 authors, inside the sprint's elapsed window. */
function defaultCommits() {
  return Array.from({ length: 14 }, (_, i) => ({
    sha: `sha${i}`,
    repoFullName: 'org/act-api',
    authorLogin: i % 2 === 0 ? 'alice' : 'bob',
    authorEmail: null,
    additions: 3,
    deletions: 1,
    committedAt: new Date(`2026-08-${26 + (i % 5)}T00:00:00.000Z`),
    authoredAt: new Date(`2026-08-${26 + (i % 5)}T00:00:00.000Z`),
  }));
}

/** 3 sprint items, each assigned to a different person. */
function defaultItems() {
  return [
    { assigneeLogin: 'alice', assigneeName: 'Alice A' },
    { assigneeLogin: 'bob', assigneeName: 'Bob B' },
    { assigneeLogin: 'carol', assigneeName: 'Carol C' },
  ];
}

/**
 * 2 PRs: one merged and reviewed, one still open and unreviewed since well
 * before the 24h waiting threshold (opened 2026-08-27, "now" 2026-08-31).
 */
function defaultPrs() {
  return [
    {
      repoFullName: 'org/act-api',
      externalNumber: '1',
      authorLogin: 'alice',
      state: 'merged',
      openedAt: new Date('2026-08-26T00:00:00.000Z'),
      firstReviewAt: new Date('2026-08-26T04:00:00.000Z'),
      mergedAt: new Date('2026-08-27T00:00:00.000Z'),
    },
    {
      repoFullName: 'org/act-api',
      externalNumber: '2',
      authorLogin: 'bob',
      state: 'open',
      openedAt: new Date('2026-08-27T00:00:00.000Z'),
      firstReviewAt: null,
      mergedAt: null,
    },
  ];
}

describe('SprintHealthDetailService.commitActivity', () => {
  let planning: jest.Mocked<PlanningService>;
  let code: jest.Mocked<CodeService>;
  let identities: jest.Mocked<DeveloperIdentityService>;
  let insights: jest.Mocked<InsightsService>;
  let tenantContext: jest.Mocked<TenantContextService>;
  let prisma: { pullRequest: { findMany: jest.Mock } };
  let service: SprintHealthDetailService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-31T00:00:00.000Z'));

    planning = {
      // The sprint exists only for tenant 't1' + externalId '42' — the same
      // point read a real `tenantId_externalId` unique lookup would give:
      // wrong id OR wrong tenant is the same "not found".
      findSprintByExternalId: jest.fn(
        async (tenantId: string, externalId: string) =>
          tenantId === 't1' && externalId === '42' ? defaultSprint() : null,
      ),
      listSprints: jest.fn().mockResolvedValue([]),
      listItemsForSprint: jest.fn().mockResolvedValue(defaultItems()),
    } as unknown as jest.Mocked<PlanningService>;

    code = {
      listCommitsPage: jest
        .fn()
        .mockResolvedValue({ commits: defaultCommits(), truncated: false }),
    } as unknown as jest.Mocked<CodeService>;

    identities = {
      attributionIndex: jest.fn().mockResolvedValue({
        byLogin: new Map<string, string>(),
        byEmail: new Map<string, string>(),
        displayNames: new Map<string, string>(),
      }),
    } as unknown as jest.Mocked<DeveloperIdentityService>;

    insights = {
      repoToProjects: jest
        .fn()
        .mockResolvedValue(new Map([['org/act-api', ['ACT']]])),
    } as unknown as jest.Mocked<InsightsService>;

    tenantContext = {
      requireTenantId: jest.fn().mockReturnValue('t1'),
    } as unknown as jest.Mocked<TenantContextService>;

    prisma = {
      pullRequest: { findMany: jest.fn().mockResolvedValue(defaultPrs()) },
    };

    service = new SprintHealthDetailService(
      tenantContext,
      prisma as unknown as PrismaService,
      planning,
      code,
      identities,
      insights,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns null for a sprint that does not exist', async () => {
    planning.listSprints.mockResolvedValue([]);
    expect(await service.commitActivity('999')).toBeNull();
  });

  it('counts committers against the sprint assignee roster', async () => {
    // 2 people committed; 3 people are assigned items in the sprint.
    const view = await service.commitActivity('42');
    expect(view).toMatchObject({ committers: 2, assignees: 3 });
  });

  it('windows commits to the sprint and averages over its elapsed days', async () => {
    // Sprint: 2026-08-25 → 2026-09-05, "now" 2026-08-31 → 7 elapsed days.
    const view = await service.commitActivity('42');
    expect(view?.commits).toBe(14);
    expect(view?.commitsPerDay).toBe(2);
  });

  // A sprint with no reviewed PR has no average. Reporting 0 would say
  // "reviewed instantly", the opposite of the truth.
  it('reports a null first-review average when nothing has been reviewed', async () => {
    prisma.pullRequest.findMany.mockResolvedValue([
      {
        authorLogin: 'a',
        openedAt: new Date('2026-08-26'),
        firstReviewAt: null,
        mergedAt: null,
      },
    ]);
    const view = await service.commitActivity('42');
    expect(view?.avgHoursToFirstReview).toBeNull();
    expect(view?.prsReviewed).toBe(0);
  });

  it('counts PRs still waiting over 24h for a first review', async () => {
    const view = await service.commitActivity('42');
    expect(view?.prsWaitingOver24h).toBe(1);
  });

  it('scopes commits to repos mapped to the sprint project', async () => {
    insights.repoToProjects.mockResolvedValue(
      new Map([
        ['org/act-api', ['ACT']],
        ['org/other', ['PAY']],
      ]),
    );
    await service.commitActivity('42');
    expect(code.listCommitsPage).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        repos: ['org/act-api'],
      }),
    );
  });

  // The guard that stops an unmapped project from reading every repo in the
  // tenant: `listCommitsPage` treats an EMPTY `repos` filter as "no filter",
  // so when nothing maps to this sprint's project the service must skip the
  // read entirely rather than pass `repos: []` through.
  it('reports zero commits and skips the read entirely when no repo maps to the sprint project', async () => {
    insights.repoToProjects.mockResolvedValue(
      new Map([['org/other', ['PAY']]]),
    );
    const view = await service.commitActivity('42');
    expect(code.listCommitsPage).not.toHaveBeenCalled();
    expect(prisma.pullRequest.findMany).not.toHaveBeenCalled();
    expect(view).toMatchObject({ commits: 0, repos: [] });
  });

  // Isolation is tested, not assumed. Every read on this service resolves its
  // tenant from the request context and passes it down; none takes one from
  // the caller, so a sprint id alone can never reach another tenant's data.
  // All six tenant-consuming calls are asserted here, not a sample of them —
  // Tasks 7-10 add three more methods to this same class and will follow
  // this file's pattern, so a gap here is a gap copied four times.
  it('scopes every query by the tenant from the request context', async () => {
    tenantContext.requireTenantId.mockReturnValue('t-other');
    // Made reachable under the OTHER tenant too, so this test proves every
    // downstream call threads 't-other' rather than merely proving the
    // sprint lookup got it (the null-return path is covered separately).
    planning.findSprintByExternalId.mockImplementation(
      async (tenantId: string, externalId: string) =>
        tenantId === 't-other' && externalId === '42' ? defaultSprint() : null,
    );

    await service.commitActivity('42');

    expect(planning.findSprintByExternalId).toHaveBeenCalledWith(
      't-other',
      '42',
    );
    expect(planning.listItemsForSprint).toHaveBeenCalledWith('t-other', '42');
    expect(insights.repoToProjects).toHaveBeenCalledWith('t-other');
    expect(code.listCommitsPage).toHaveBeenCalledWith(
      't-other',
      expect.anything(),
    );
    expect(identities.attributionIndex).toHaveBeenCalledWith('t-other');
    expect(prisma.pullRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 't-other' }),
      }),
    );
  });

  // Models the actual isolation boundary: the point read is scoped by the
  // REQUESTING tenant, so a sprint that exists — under a DIFFERENT tenant —
  // is exactly as absent as one that doesn't exist at all. Distinct from
  // "returns null for a sprint that does not exist" above: here the sprint
  // is real, just not this tenant's, and the lookup must still be called
  // with the requester's own tenant id rather than skipped or guessed.
  it('returns null for a sprint id belonging to another tenant', async () => {
    tenantContext.requireTenantId.mockReturnValue('t-other');

    const view = await service.commitActivity('42');

    expect(planning.findSprintByExternalId).toHaveBeenCalledWith(
      't-other',
      '42',
    );
    expect(view).toBeNull();
    expect(code.listCommitsPage).not.toHaveBeenCalled();
    expect(prisma.pullRequest.findMany).not.toHaveBeenCalled();
  });
});
