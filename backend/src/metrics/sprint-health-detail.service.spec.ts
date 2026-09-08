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

/**
 * Six contributors, deliberately scored so that LOC and score disagree:
 * dev-a is the biggest LOC contributor by far but does almost nothing else,
 * and dev-b is the opposite. `score = ticketsWorked + prsRaised + prsReviewed`
 * for each:
 *   dev-b 9+5+6=20 (rank 1, high)   dev-c 5+5+5=15 (rank 2, high)
 *   dev-d 4+3+3=10 (rank 3, medium) dev-e 3+2+3=8  (rank 4, medium)
 *   dev-f 1+1+1=3  (rank 5, low)    dev-a 1+0+0=1  (rank 6, low)
 */
const PRODUCTIVITY_DEVS = [
  { developer: 'dev-a', additions: 4000, tickets: 1, prsRaised: 0, reviews: 0 },
  { developer: 'dev-b', additions: 100, tickets: 9, prsRaised: 5, reviews: 6 },
  { developer: 'dev-c', additions: 500, tickets: 5, prsRaised: 5, reviews: 5 },
  { developer: 'dev-d', additions: 800, tickets: 4, prsRaised: 3, reviews: 3 },
  { developer: 'dev-e', additions: 300, tickets: 3, prsRaised: 2, reviews: 3 },
  { developer: 'dev-f', additions: 150, tickets: 1, prsRaised: 1, reviews: 1 },
];

function productivityCommits() {
  return PRODUCTIVITY_DEVS.map((d, i) => ({
    sha: `sha-${d.developer}`,
    repoFullName: 'org/act-api',
    authorLogin: d.developer,
    authorEmail: null,
    additions: d.additions,
    deletions: 0,
    committedAt: new Date(`2026-08-26T0${i % 9}:00:00.000Z`),
    authoredAt: new Date(`2026-08-26T0${i % 9}:00:00.000Z`),
  }));
}

function productivityPrs() {
  return PRODUCTIVITY_DEVS.flatMap((d) =>
    Array.from({ length: d.prsRaised }, (_, i) => ({
      repoFullName: 'org/act-api',
      externalNumber: `${d.developer}-${i}`,
      authorLogin: d.developer,
      state: 'open',
      openedAt: new Date('2026-08-26T00:00:00.000Z'),
      firstReviewAt: null,
      mergedAt: null,
    })),
  );
}

function productivityReviews() {
  return PRODUCTIVITY_DEVS.flatMap((d) =>
    Array.from({ length: d.reviews }, (_, i) => ({
      repoFullName: 'org/act-api',
      externalNumber: `${d.developer}-r${i}`,
      externalId: `${d.developer}-review-${i}`,
      reviewerLogin: d.developer,
      isBot: false,
      state: 'approved',
      submittedAt: new Date('2026-08-26T00:00:00.000Z'),
    })),
  );
}

function productivityTransitions() {
  return PRODUCTIVITY_DEVS.flatMap((d) =>
    Array.from({ length: d.tickets }, (_, i) => ({
      externalKey: `ACT-${d.developer}-${i}`,
      authorLogin: d.developer,
      authorName: null,
      transitionedAt: new Date('2026-08-26T00:00:00.000Z'),
    })),
  );
}

/** The sprint's own item keys — every key `productivityTransitions` uses. */
function productivitySprintItems() {
  return productivityTransitions().map((t) => ({ externalKey: t.externalKey }));
}

function productivityJiraIndex() {
  const byDeveloper = new Map<string, { logins: string[]; names: string[] }>(
    PRODUCTIVITY_DEVS.map((d) => [
      d.developer,
      { logins: [d.developer], names: [] },
    ]),
  );
  return {
    byDeveloper,
    assignees: {
      observed: PRODUCTIVITY_DEVS.length,
      matched: PRODUCTIVITY_DEVS.length,
      unmatched: 0,
    },
  };
}

describe('SprintHealthDetailService.productivity', () => {
  let planning: jest.Mocked<PlanningService>;
  let code: jest.Mocked<CodeService>;
  let identities: jest.Mocked<DeveloperIdentityService>;
  let insights: jest.Mocked<InsightsService>;
  let tenantContext: jest.Mocked<TenantContextService>;
  let prisma: {
    pullRequest: { findMany: jest.Mock };
    prReview: { findMany: jest.Mock };
    issueStatusHistory: { findMany: jest.Mock };
  };
  let service: SprintHealthDetailService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-31T00:00:00.000Z'));

    planning = {
      findSprintByExternalId: jest.fn(
        async (tenantId: string, externalId: string) =>
          tenantId === 't1' && externalId === '42' ? defaultSprint() : null,
      ),
      listSprints: jest.fn().mockResolvedValue([]),
      listItemsForSprint: jest
        .fn()
        .mockResolvedValue(productivitySprintItems()),
    } as unknown as jest.Mocked<PlanningService>;

    code = {
      listCommitsPage: jest.fn().mockResolvedValue({
        commits: productivityCommits(),
        truncated: false,
      }),
    } as unknown as jest.Mocked<CodeService>;

    identities = {
      attributionIndex: jest.fn().mockResolvedValue({
        byLogin: new Map<string, string>(),
        byEmail: new Map<string, string>(),
        displayNames: new Map<string, string>(),
      }),
      jiraAssigneeIndex: jest.fn().mockResolvedValue(productivityJiraIndex()),
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
      pullRequest: { findMany: jest.fn().mockResolvedValue(productivityPrs()) },
      prReview: {
        findMany: jest.fn().mockResolvedValue(productivityReviews()),
      },
      issueStatusHistory: {
        findMany: jest.fn().mockResolvedValue(productivityTransitions()),
      },
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

  // The grade must not be a LOC proxy: this is the one rule the board's
  // ethics hang on, and it is invisible in the rendered pill.
  it('grades on tickets + PRs + reviews, never on LOC', async () => {
    // dev-a: 4,000 LOC, 1 ticket, 0 PRs, 0 reviews
    // dev-b:   100 LOC, 9 tickets, 5 PRs, 6 reviews
    const view = await service.productivity('42');
    const byDev = new Map(view!.rows.map((r) => [r.developer, r]));
    expect(byDev.get('dev-b')!.grade).toBe('high');
    expect(byDev.get('dev-a')!.grade).toBe('low');
  });

  it('cuts tertiles across this sprint contributors', async () => {
    const view = await service.productivity('42');
    expect(view!.rows.map((r) => r.grade)).toEqual([
      'high',
      'high',
      'medium',
      'medium',
      'low',
      'low',
    ]);
  });

  it('publishes the rule it graded by', async () => {
    const view = await service.productivity('42');
    expect(view!.gradeRule).toContain('not lines of code');
  });

  it('reports highest and lowest LOC contributors', async () => {
    const view = await service.productivity('42');
    expect(view!.highest).toEqual({ additions: 4000 });
    expect(view!.lowest).toEqual({ additions: 100 });
  });

  // One contributor cannot be a tertile. Grading them "high" or "low" would
  // be a verdict drawn from a distribution of one.
  it('grades everyone medium when there are too few contributors to rank', async () => {
    // Only dev-a and dev-b carry any signal — 2 contributors, not a tertile.
    const onlyAB = (developer: string) =>
      developer === 'dev-a' || developer === 'dev-b';
    code.listCommitsPage.mockResolvedValue({
      commits: productivityCommits().filter((c) =>
        onlyAB(c.authorLogin),
      ) as unknown as Awaited<
        ReturnType<CodeService['listCommitsPage']>
      >['commits'],
      truncated: false,
    });
    prisma.pullRequest.findMany.mockResolvedValue(
      productivityPrs().filter((pr) => onlyAB(pr.authorLogin)),
    );
    prisma.prReview.findMany.mockResolvedValue(
      productivityReviews().filter((r) => onlyAB(r.reviewerLogin)),
    );
    prisma.issueStatusHistory.findMany.mockResolvedValue(
      productivityTransitions().filter((t) => onlyAB(t.authorLogin)),
    );
    identities.jiraAssigneeIndex.mockResolvedValue({
      byDeveloper: new Map(
        [...productivityJiraIndex().byDeveloper].filter(([dev]) => onlyAB(dev)),
      ),
      assignees: { observed: 2, matched: 2, unmatched: 0 },
    });

    const view = await service.productivity('42');
    expect(view!.rows.every((r) => r.grade === 'medium')).toBe(true);
    expect(view!.highest).toBeNull();
  });

  // A commit-only developer did real work, but not the kind this composite
  // counts. They must not (a) pad the contributor count past the
  // rankable threshold on someone else's behalf, or (b) be graded "low" for
  // a signal the composite never looked at — that is the LOC blindness this
  // panel exists to avoid, inverted.
  it('grades everyone medium when only one contributor carries any signal — two more commit only', async () => {
    const signalDev = 'dev-b'; // ticketsWorked 9, prsRaised 5, reviews 6
    const commitOnly = ['dev-c', 'dev-d']; // score 0: commits, nothing else
    const included = new Set([signalDev, ...commitOnly]);

    code.listCommitsPage.mockResolvedValue({
      commits: productivityCommits().filter((c) =>
        included.has(c.authorLogin),
      ) as unknown as Awaited<
        ReturnType<CodeService['listCommitsPage']>
      >['commits'],
      truncated: false,
    });
    prisma.pullRequest.findMany.mockResolvedValue(
      productivityPrs().filter((pr) => pr.authorLogin === signalDev),
    );
    prisma.prReview.findMany.mockResolvedValue(
      productivityReviews().filter((r) => r.reviewerLogin === signalDev),
    );
    prisma.issueStatusHistory.findMany.mockResolvedValue(
      productivityTransitions().filter((t) => t.authorLogin === signalDev),
    );
    identities.jiraAssigneeIndex.mockResolvedValue({
      byDeveloper: new Map(
        [...productivityJiraIndex().byDeveloper].filter(
          ([dev]) => dev === signalDev,
        ),
      ),
      assignees: { observed: 1, matched: 1, unmatched: 0 },
    });

    const view = await service.productivity('42');

    // 3 rows in the table (commit-only developers are shown, not dropped)...
    expect(view!.rows).toHaveLength(3);
    // ...but the real n for ranking is 1, so nobody is ranked at all.
    expect(view!.rows.every((r) => r.grade === 'medium')).toBe(true);
    expect(view!.highest).toBeNull();
    expect(view!.lowest).toBeNull();
    // The commit-only developers' real LOC work is still on the table.
    const byDev = new Map(view!.rows.map((r) => [r.developer, r]));
    expect(byDev.get('dev-c')!.additions).toBe(500);
    expect(byDev.get('dev-d')!.additions).toBe(800);
  });

  // Same isolation boundary as `commitActivity`: every downstream read is
  // reached only through the tenant resolved from the request context.
  it('scopes every query by the tenant from the request context', async () => {
    tenantContext.requireTenantId.mockReturnValue('t-other');
    planning.findSprintByExternalId.mockImplementation(
      async (tenantId: string, externalId: string) =>
        tenantId === 't-other' && externalId === '42' ? defaultSprint() : null,
    );

    await service.productivity('42');

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
    expect(identities.jiraAssigneeIndex).toHaveBeenCalledWith('t-other');
    expect(prisma.pullRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 't-other' }),
      }),
    );
    expect(prisma.prReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 't-other' }),
      }),
    );
    expect(prisma.issueStatusHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 't-other' }),
      }),
    );
  });

  // The sprint is real, just not this tenant's — exactly as absent as one
  // that does not exist at all, and the downstream reads must never fire.
  it('returns null for a sprint id belonging to another tenant', async () => {
    tenantContext.requireTenantId.mockReturnValue('t-other');

    const view = await service.productivity('42');

    expect(planning.findSprintByExternalId).toHaveBeenCalledWith(
      't-other',
      '42',
    );
    expect(view).toBeNull();
    expect(planning.listItemsForSprint).not.toHaveBeenCalled();
    expect(code.listCommitsPage).not.toHaveBeenCalled();
    expect(prisma.pullRequest.findMany).not.toHaveBeenCalled();
    expect(prisma.prReview.findMany).not.toHaveBeenCalled();
    expect(prisma.issueStatusHistory.findMany).not.toHaveBeenCalled();
  });
});

/**
 * 18 stories, each carrying a release and a done-transition inside the
 * window, plus 29 bugs split 4/8/11/6 across Highest/High/Medium/Low. Bugs
 * carry no release and stay out of `done`, so they never contribute to
 * `storiesReleased` — only `bugsByPriority`/`bugsLogged` see them.
 */
function qualityCheckItems() {
  const stories = Array.from({ length: 18 }, (_, i) => ({
    externalKey: `ACT-S${i + 1}`,
    type: 'story',
    statusCategory: 'done',
    releases: ['R1'],
    priority: 'Medium',
  }));
  const bugPriorities = [
    ...Array(4).fill('Highest'),
    ...Array(8).fill('High'),
    ...Array(11).fill('Medium'),
    ...Array(6).fill('Low'),
  ];
  const bugs = bugPriorities.map((priority, i) => ({
    externalKey: `ACT-B${i + 1}`,
    type: 'bug',
    statusCategory: 'new',
    releases: [],
    priority,
  }));
  return [...stories, ...bugs];
}

/** One toCategory: 'done' transition per released story, inside the window. */
function qualityCheckDoneTransitions() {
  return Array.from({ length: 18 }, (_, i) => ({
    externalKey: `ACT-S${i + 1}`,
    fromCategory: 'indeterminate',
    toCategory: 'done',
    transitionedAt: new Date('2026-08-28'),
  }));
}

describe('SprintHealthDetailService.qualityCheck', () => {
  let planning: jest.Mocked<PlanningService>;
  let insights: jest.Mocked<InsightsService>;
  let tenantContext: jest.Mocked<TenantContextService>;
  let history: { findMany: jest.Mock };
  let prisma: { issueStatusHistory: { findMany: jest.Mock } };
  let service: SprintHealthDetailService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-31T00:00:00.000Z'));

    planning = {
      findSprintByExternalId: jest.fn(
        async (tenantId: string, externalId: string) =>
          tenantId === 't1' && externalId === '42' ? defaultSprint() : null,
      ),
      listSprints: jest.fn().mockResolvedValue([]),
      listItemsForSprint: jest.fn().mockResolvedValue(qualityCheckItems()),
    } as unknown as jest.Mocked<PlanningService>;

    insights = {
      repoToProjects: jest
        .fn()
        .mockResolvedValue(new Map([['org/act-api', ['ACT']]])),
    } as unknown as jest.Mocked<InsightsService>;

    tenantContext = {
      requireTenantId: jest.fn().mockReturnValue('t1'),
    } as unknown as jest.Mocked<TenantContextService>;

    history = {
      findMany: jest.fn().mockResolvedValue(qualityCheckDoneTransitions()),
    };
    prisma = { issueStatusHistory: history };

    service = new SprintHealthDetailService(
      tenantContext,
      prisma as unknown as PrismaService,
      planning,
      {} as unknown as CodeService,
      {} as unknown as DeveloperIdentityService,
      insights,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('counts stories that carry a release and reached done in the window', async () => {
    const view = await service.qualityCheck('42');
    expect(view!.storiesReleased).toBe(18);
  });

  // "Rolled back" is a transition OUT of done, which only the status history
  // can show — the story row alone carries the current status and would report
  // a reopened-then-refixed item as if nothing had happened.
  it('counts items that left a done status after entering one', async () => {
    history.findMany.mockResolvedValue([
      {
        externalKey: 'ACT-1',
        fromCategory: 'done',
        toCategory: 'indeterminate',
        transitionedAt: new Date('2026-08-28'),
      },
      {
        externalKey: 'ACT-1',
        fromCategory: 'indeterminate',
        toCategory: 'done',
        transitionedAt: new Date('2026-08-29'),
      },
    ]);
    const view = await service.qualityCheck('42');
    expect(view!.rolledBack).toBe(1);
  });

  it('groups bugs by priority, keeping Jira order', async () => {
    const view = await service.qualityCheck('42');
    expect(view!.bugsByPriority).toEqual([
      { priority: 'Highest', count: 4 },
      { priority: 'High', count: 8 },
      { priority: 'Medium', count: 11 },
      { priority: 'Low', count: 6 },
    ]);
  });

  // Isolation is tested, not assumed — same pattern as commitActivity and
  // productivity above.
  it('scopes every query by the tenant from the request context', async () => {
    tenantContext.requireTenantId.mockReturnValue('t-other');
    planning.findSprintByExternalId.mockImplementation(
      async (tenantId: string, externalId: string) =>
        tenantId === 't-other' && externalId === '42' ? defaultSprint() : null,
    );

    await service.qualityCheck('42');

    expect(planning.findSprintByExternalId).toHaveBeenCalledWith(
      't-other',
      '42',
    );
    expect(planning.listItemsForSprint).toHaveBeenCalledWith('t-other', '42');
    expect(insights.repoToProjects).toHaveBeenCalledWith('t-other');
    expect(history.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 't-other' }),
      }),
    );
  });

  it('returns null for a sprint id belonging to another tenant', async () => {
    tenantContext.requireTenantId.mockReturnValue('t-other');

    const view = await service.qualityCheck('42');

    expect(planning.findSprintByExternalId).toHaveBeenCalledWith(
      't-other',
      '42',
    );
    expect(view).toBeNull();
    expect(planning.listItemsForSprint).not.toHaveBeenCalled();
    expect(history.findMany).not.toHaveBeenCalled();
  });
});

describe('SprintHealthDetailService.qualityCheck when nothing has been released', () => {
  let planning: jest.Mocked<PlanningService>;
  let insights: jest.Mocked<InsightsService>;
  let tenantContext: jest.Mocked<TenantContextService>;
  let prisma: { issueStatusHistory: { findMany: jest.Mock } };
  let service: SprintHealthDetailService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-31T00:00:00.000Z'));

    planning = {
      findSprintByExternalId: jest.fn(
        async (tenantId: string, externalId: string) =>
          tenantId === 't1' && externalId === '42' ? defaultSprint() : null,
      ),
      listSprints: jest.fn().mockResolvedValue([]),
      // No released stories at all: a handful of bugs, still open, still
      // logged — nothing has reached `done`, so nothing was released.
      listItemsForSprint: jest.fn().mockResolvedValue([
        {
          externalKey: 'ACT-B1',
          type: 'bug',
          statusCategory: 'new',
          releases: [],
          priority: 'Medium',
        },
        {
          externalKey: 'ACT-B2',
          type: 'bug',
          statusCategory: 'indeterminate',
          releases: [],
          priority: 'Low',
        },
      ]),
    } as unknown as jest.Mocked<PlanningService>;

    insights = {
      repoToProjects: jest
        .fn()
        .mockResolvedValue(new Map([['org/act-api', ['ACT']]])),
    } as unknown as jest.Mocked<InsightsService>;

    tenantContext = {
      requireTenantId: jest.fn().mockReturnValue('t1'),
    } as unknown as jest.Mocked<TenantContextService>;

    prisma = {
      issueStatusHistory: { findMany: jest.fn().mockResolvedValue([]) },
    };

    service = new SprintHealthDetailService(
      tenantContext,
      prisma as unknown as PrismaService,
      planning,
      {} as unknown as CodeService,
      {} as unknown as DeveloperIdentityService,
      insights,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Zero would read as "we released and got no bugs" — the opposite of "we
  // released nothing".
  it('reports a null bug ratio when nothing was released', async () => {
    const view = await service.qualityCheck('42');
    expect(view!.storiesReleased).toBe(0);
    expect(view!.bugsPerStoryReleased).toBeNull();
  });
});

describe('SprintHealthDetailService.checkIns', () => {
  let planning: jest.Mocked<PlanningService>;
  let insights: jest.Mocked<InsightsService>;
  let tenantContext: jest.Mocked<TenantContextService>;
  let history: { findMany: jest.Mock };
  let prisma: { issueStatusHistory: { findMany: jest.Mock } };
  let service: SprintHealthDetailService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-31T00:00:00.000Z'));

    planning = {
      findSprintByExternalId: jest.fn(
        async (tenantId: string, externalId: string) =>
          tenantId === 't1' && externalId === '42' ? defaultSprint() : null,
      ),
      listSprints: jest.fn().mockResolvedValue([]),
      listItemsForSprint: jest
        .fn()
        .mockResolvedValue([
          { externalKey: 'ACT-1' },
          { externalKey: 'ACT-2' },
        ]),
    } as unknown as jest.Mocked<PlanningService>;

    insights = {
      repoToProjects: jest
        .fn()
        .mockResolvedValue(new Map([['org/act-api', ['ACT']]])),
    } as unknown as jest.Mocked<InsightsService>;

    tenantContext = {
      requireTenantId: jest.fn().mockReturnValue('t1'),
    } as unknown as jest.Mocked<TenantContextService>;

    history = {
      findMany: jest.fn().mockResolvedValue([]),
    };
    prisma = { issueStatusHistory: history };

    service = new SprintHealthDetailService(
      tenantContext,
      prisma as unknown as PrismaService,
      planning,
      {} as unknown as CodeService,
      {} as unknown as DeveloperIdentityService,
      insights,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('buckets transitions per developer per IST day', async () => {
    history.findMany.mockResolvedValue([
      {
        authorLogin: 'rahul',
        authorName: 'Rahul S.',
        transitionedAt: new Date('2026-08-25T04:00:00Z'),
      },
      {
        authorLogin: 'rahul',
        authorName: 'Rahul S.',
        transitionedAt: new Date('2026-08-25T09:00:00Z'),
      },
      {
        authorLogin: 'priya',
        authorName: 'Priya N.',
        transitionedAt: new Date('2026-08-26T05:00:00Z'),
      },
    ]);
    const view = await service.checkIns(
      '42',
      new Date('2026-08-25'),
      new Date('2026-08-26'),
    );

    expect(view!.days).toEqual(['2026-08-25', '2026-08-26']);
    expect(view!.rows).toEqual([
      { developer: 'rahul', displayName: 'Rahul S.', counts: [2, 0], total: 2 },
      { developer: 'priya', displayName: 'Priya N.', counts: [0, 1], total: 1 },
    ]);
  });

  // 18:30 UTC is the next IST day. Bucketing this in UTC would put a Monday
  // evening check-in on Monday for this board and Tuesday on every other one.
  it('uses the IST day boundary, like every other daily series', async () => {
    history.findMany.mockResolvedValue([
      {
        authorLogin: 'rahul',
        authorName: 'Rahul S.',
        transitionedAt: new Date('2026-08-25T19:00:00Z'),
      },
    ]);
    const view = await service.checkIns(
      '42',
      new Date('2026-08-25'),
      new Date('2026-08-26'),
    );
    expect(view!.rows[0].counts).toEqual([0, 1]);
  });

  it('clamps the requested range to the sprint own days', async () => {
    // Sprint runs 2026-08-25 → 2026-09-05; caller asks for all of August.
    const view = await service.checkIns(
      '42',
      new Date('2026-08-01'),
      new Date('2026-08-31'),
    );
    expect(view!.days[0]).toBe('2026-08-25');
  });

  it('defaults to the first seven sprint days when no range is given', async () => {
    const view = await service.checkIns('42');
    expect(view!.days).toHaveLength(7);
    expect(view!.days[0]).toBe('2026-08-25');
  });

  // A stale link, a hand-edited URL, or a pager page built from the wrong
  // bounds must degrade to the nearest valid days, not invert into a
  // column-less grid: `end` was previously derived independently of
  // `start`'s clamp, so a range entirely past the elapsed window (2026-08-31,
  // "now" for this fixture) put `start > end` and `dayKeysBetween` returned
  // `[]`.
  it('degrades a range entirely after the elapsed window to its last day, not an empty grid', async () => {
    const view = await service.checkIns(
      '42',
      new Date('2026-09-02'),
      new Date('2026-09-04'),
    );
    expect(view!.days).toEqual(['2026-08-31']);
  });

  // The same inversion, symmetrically, for a range entirely before the
  // sprint started.
  it('degrades a range entirely before the sprint start to its first day, not an empty grid', async () => {
    const view = await service.checkIns(
      '42',
      new Date('2026-08-01'),
      new Date('2026-08-10'),
    );
    expect(view!.days).toEqual(['2026-08-25']);
  });

  // `sprintFrom`/`sprintTo` are the ELAPSED window, not the sprint's full
  // planned bounds (endAt is 2026-09-05, well past "now"): the pager builds
  // its pages from these two fields, so a page for days that have not
  // happened yet must never be offered.
  it('reports the elapsed window, not the full sprint bounds, for a running sprint', async () => {
    const view = await service.checkIns('42');
    expect(view!.sprintFrom).toBe('2026-08-25');
    expect(view!.sprintTo).toBe('2026-08-31');
  });

  it('returns an empty row set, not null, for a sprint nobody moved a ticket in', async () => {
    history.findMany.mockResolvedValue([]);
    const view = await service.checkIns('42');
    expect(view!.rows).toEqual([]);
    expect(view!.days).toHaveLength(7);
  });

  // Same population as productivity/qualityCheck: scoped to THIS SPRINT'S
  // OWN item keys, skipped entirely when there are none.
  it('skips the read and returns an empty row set when the sprint has no items', async () => {
    planning.listItemsForSprint.mockResolvedValue([]);
    const view = await service.checkIns('42');
    expect(history.findMany).not.toHaveBeenCalled();
    expect(view!.rows).toEqual([]);
  });

  // Isolation is tested, not assumed — same pattern as commitActivity,
  // productivity and qualityCheck above.
  it('scopes every query by the tenant from the request context', async () => {
    tenantContext.requireTenantId.mockReturnValue('t-other');
    planning.findSprintByExternalId.mockImplementation(
      async (tenantId: string, externalId: string) =>
        tenantId === 't-other' && externalId === '42' ? defaultSprint() : null,
    );

    await service.checkIns('42');

    expect(planning.findSprintByExternalId).toHaveBeenCalledWith(
      't-other',
      '42',
    );
    expect(planning.listItemsForSprint).toHaveBeenCalledWith('t-other', '42');
    expect(insights.repoToProjects).toHaveBeenCalledWith('t-other');
    expect(history.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 't-other' }),
      }),
    );
  });

  it('returns null for a sprint id belonging to another tenant', async () => {
    tenantContext.requireTenantId.mockReturnValue('t-other');

    const view = await service.checkIns('42');

    expect(planning.findSprintByExternalId).toHaveBeenCalledWith(
      't-other',
      '42',
    );
    expect(view).toBeNull();
    expect(planning.listItemsForSprint).not.toHaveBeenCalled();
    expect(history.findMany).not.toHaveBeenCalled();
  });
});

/**
 * Default release-candidate fixture: RC1 carries 5 stories (2 done, 3
 * pending) and 9 bugs (3 Highest + 6 High), all bearing an Affects Version —
 * the population `bugSource: 'affects-version'` reads. RC2/RC3 each carry one
 * filler story purely so their names surface in the distinct-release
 * collection off the sprint's own items.
 */
function defaultReleaseCandidateItems() {
  const rc1Stories = [
    {
      externalKey: 'ACT-4221',
      type: 'story',
      title: 'Slot search caching',
      statusCategory: 'done',
      releases: ['RC1'],
      affectsReleases: [],
      priority: null,
    },
    {
      externalKey: 'ACT-4222',
      type: 'story',
      title: 'Appointment confirm email',
      statusCategory: 'done',
      releases: ['RC1'],
      affectsReleases: [],
      priority: null,
    },
    {
      externalKey: 'ACT-4223',
      type: 'story',
      title: 'Waitlist auto-promote',
      statusCategory: 'indeterminate',
      releases: ['RC1'],
      affectsReleases: [],
      priority: null,
    },
    {
      externalKey: 'ACT-4224',
      type: 'story',
      title: 'Doctor calendar sync',
      statusCategory: 'new',
      releases: ['RC1'],
      affectsReleases: [],
      priority: null,
    },
    {
      externalKey: 'ACT-4225',
      type: 'story',
      title: 'Appointment reschedule notification',
      statusCategory: 'new',
      releases: ['RC1'],
      affectsReleases: [],
      priority: null,
    },
  ];
  const rc1BugsHighest = Array.from({ length: 3 }, (_, i) => ({
    externalKey: `ACT-51${i}`,
    type: 'bug',
    title: `Highest bug ${i}`,
    statusCategory: 'new',
    releases: ['RC1'],
    affectsReleases: ['RC1'],
    priority: 'Highest',
  }));
  const rc1BugsHigh = Array.from({ length: 6 }, (_, i) => ({
    externalKey: `ACT-52${i}`,
    type: 'bug',
    title: `High bug ${i}`,
    statusCategory: 'new',
    releases: ['RC1'],
    affectsReleases: ['RC1'],
    priority: 'High',
  }));
  const rc2Story = {
    externalKey: 'ACT-4301',
    type: 'story',
    title: 'RC2 filler story',
    statusCategory: 'done',
    releases: ['RC2'],
    affectsReleases: [],
    priority: null,
  };
  const rc3Story = {
    externalKey: 'ACT-4401',
    type: 'story',
    title: 'RC3 filler story',
    statusCategory: 'new',
    releases: ['RC3'],
    affectsReleases: [],
    priority: null,
  };
  return [...rc1Stories, ...rc1BugsHighest, ...rc1BugsHigh, rc2Story, rc3Story];
}

/** 3 `planning_release` rows: RC1 released+late, RC2 released+no plan, RC3 unreleased. */
function defaultReleases() {
  return [
    {
      name: 'RC1',
      projectKey: 'ACT',
      externalId: '10001',
      released: true,
      releaseDate: new Date('2026-08-20T00:00:00.000Z'),
      plannedReleaseAt: new Date('2026-08-18T00:00:00.000Z'),
    },
    {
      name: 'RC2',
      projectKey: 'ACT',
      externalId: '10002',
      released: true,
      releaseDate: new Date('2026-08-25T00:00:00.000Z'),
      plannedReleaseAt: null,
    },
    {
      // `releaseDate` is populated but `released` is false: Jira's "expected
      // to finish" reading of the same field an unreleased RC still carries.
      // Left non-null on purpose — a null here would make the "no actual
      // date for an unreleased RC" test pass whether or not the `released`
      // gate is applied at all, which is no test.
      name: 'RC3',
      projectKey: 'ACT',
      externalId: '10003',
      released: false,
      releaseDate: new Date('2026-09-03T00:00:00.000Z'),
      plannedReleaseAt: null,
    },
  ];
}

describe('SprintHealthDetailService.releaseCandidates', () => {
  let planning: jest.Mocked<PlanningService>;
  let insights: jest.Mocked<InsightsService>;
  let tenantContext: jest.Mocked<TenantContextService>;
  let release: { findMany: jest.Mock };
  let story: { findMany: jest.Mock };
  let prisma: {
    release: { findMany: jest.Mock };
    story: { findMany: jest.Mock };
  };
  let service: SprintHealthDetailService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-31T00:00:00.000Z'));

    planning = {
      findSprintByExternalId: jest.fn(
        async (tenantId: string, externalId: string) =>
          tenantId === 't1' && externalId === '42' ? defaultSprint() : null,
      ),
      listSprints: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<PlanningService>;

    insights = {
      repoToProjects: jest
        .fn()
        .mockResolvedValue(new Map([['org/act-api', ['ACT']]])),
    } as unknown as jest.Mocked<InsightsService>;

    tenantContext = {
      requireTenantId: jest.fn().mockReturnValue('t1'),
    } as unknown as jest.Mocked<TenantContextService>;

    release = { findMany: jest.fn().mockResolvedValue(defaultReleases()) };
    story = {
      findMany: jest.fn().mockResolvedValue(defaultReleaseCandidateItems()),
    };
    prisma = { release, story };

    service = new SprintHealthDetailService(
      tenantContext,
      prisma as unknown as PrismaService,
      planning,
      {} as unknown as CodeService,
      {} as unknown as DeveloperIdentityService,
      insights,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lists one entry per release carried by the sprint stories', async () => {
    const view = await service.releaseCandidates('42');
    expect(view!.map((r) => r.name)).toEqual(['RC1', 'RC2', 'RC3']);
  });

  it('computes lateness from the planned date against Jira release date', async () => {
    release.findMany.mockResolvedValue([
      {
        name: 'RC1',
        projectKey: 'ACT',
        externalId: '1',
        released: true,
        releaseDate: new Date('2026-08-22'),
        plannedReleaseAt: new Date('2026-08-20'),
      },
    ]);
    const view = await service.releaseCandidates('42');
    expect(view![0]).toMatchObject({
      daysLate: 2,
      actualReleaseAt: '2026-08-22T00:00:00.000Z',
    });
  });

  // Jira overwrites the planned date on release, so without a recorded plan
  // there is nothing to compare against. Inventing one — from startDate, from
  // the sprint end — would be a fabricated verdict on a real team.
  it('reports null lateness when no planned date was recorded', async () => {
    release.findMany.mockResolvedValue([
      {
        name: 'RC1',
        projectKey: 'ACT',
        released: true,
        releaseDate: new Date('2026-08-22'),
        plannedReleaseAt: null,
      },
    ]);
    const view = await service.releaseCandidates('42');
    expect(view![0].daysLate).toBeNull();
  });

  it('reports no actual date for an unreleased RC', async () => {
    const view = await service.releaseCandidates('42');
    expect(view!.at(-1)).toMatchObject({
      released: false,
      actualReleaseAt: null,
      daysLate: null,
    });
  });

  it('splits stories into delivered and pending', async () => {
    const view = await service.releaseCandidates('42');
    expect(view![0]).toMatchObject({ storiesDelivered: 2, storiesTotal: 5 });
    expect(view![0].stories).toContainEqual({
      key: 'ACT-4225',
      title: 'Appointment reschedule notification',
      delivered: false,
    });
  });

  // An epic is a container, not a deliverable, and a subtask carries its
  // parent's release without adding any work the parent doesn't already
  // report — counting either would misstate the RC's scope list.
  it('excludes epics and subtasks from the RC scope list', async () => {
    story.findMany.mockResolvedValue([
      ...defaultReleaseCandidateItems(),
      {
        externalKey: 'ACT-EPIC1',
        type: 'epic',
        title: 'Appointment scheduling epic',
        statusCategory: 'done',
        releases: ['RC1'],
        affectsReleases: [],
        priority: null,
      },
      {
        externalKey: 'ACT-SUB1',
        type: 'subtask',
        title: 'Subtask of ACT-4221',
        statusCategory: 'done',
        releases: ['RC1'],
        affectsReleases: [],
        priority: null,
      },
    ]);
    const view = await service.releaseCandidates('42');
    expect(view![0].storiesTotal).toBe(5);
    expect(view![0].stories.map((s) => s.key)).toEqual(
      expect.not.arrayContaining(['ACT-EPIC1', 'ACT-SUB1']),
    );
  });

  it('counts bugs by Affects Version and says so', async () => {
    const view = await service.releaseCandidates('42');
    expect(view![0].bugSource).toBe('affects-version');
    expect(view![0].bugsByPriority).toEqual([
      { priority: 'Highest', count: 3 },
      { priority: 'High', count: 6 },
    ]);
  });

  // Stories collected before Affects Version was requested carry none. The
  // fallback keeps the panel useful, and the label keeps it honest about
  // which question the number answers.
  it('falls back to fixVersion and labels the fallback when no story carries an affects version', async () => {
    story.findMany.mockResolvedValue([
      {
        externalKey: 'ACT-1',
        type: 'bug',
        priority: 'High',
        releases: ['RC1'],
        affectsReleases: [],
      },
    ]);
    const view = await service.releaseCandidates('42');
    expect(view![0].bugSource).toBe('fix-version-fallback');
    expect(view![0].bugsByPriority).toEqual([{ priority: 'High', count: 1 }]);
  });

  it('carries a null test-execution block for the panel placeholder', async () => {
    const view = await service.releaseCandidates('42');
    expect(view![0].testExecution).toBeNull();
  });

  // Isolation is tested, not assumed — same pattern as every other read above.
  it('scopes every query by the tenant from the request context', async () => {
    tenantContext.requireTenantId.mockReturnValue('t-other');
    planning.findSprintByExternalId.mockImplementation(
      async (tenantId: string, externalId: string) =>
        tenantId === 't-other' && externalId === '42' ? defaultSprint() : null,
    );

    await service.releaseCandidates('42');

    expect(planning.findSprintByExternalId).toHaveBeenCalledWith(
      't-other',
      '42',
    );
    expect(insights.repoToProjects).toHaveBeenCalledWith('t-other');
    expect(story.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 't-other' }),
      }),
    );
    expect(release.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 't-other' }),
      }),
    );
  });

  it('returns null for a sprint id belonging to another tenant', async () => {
    tenantContext.requireTenantId.mockReturnValue('t-other');

    const view = await service.releaseCandidates('42');

    expect(planning.findSprintByExternalId).toHaveBeenCalledWith(
      't-other',
      '42',
    );
    expect(view).toBeNull();
    expect(story.findMany).not.toHaveBeenCalled();
    expect(release.findMany).not.toHaveBeenCalled();
  });
});
