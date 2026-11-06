import { CorrelationService } from '../correlation/correlation.service';
import { DeveloperIdentityService } from '../correlation/developer-identity.service';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { PrismaService } from '../database/prisma.service';
import { CodeService } from '../modules/code/code.service';
import { PlanningService } from '../modules/planning/planning.service';
import { SprintHealthDetailService } from './sprint-health-detail.service';

const SPRINT = {
  id: 'sprint-1',
  tenantId: 't1',
  externalId: '42',
  name: 'Sprint-26-11',
  state: 'active',
  projectKey: 'ACT',
  startAt: new Date('2026-11-01T00:00:00.000Z'),
  endAt: new Date('2026-11-29T00:00:00.000Z'),
};

function item(
  key: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `id-${key}`,
    externalKey: key,
    projectKey: key.split('-')[0],
    title: `Title ${key}`,
    type: 'story',
    status: 'In Development',
    statusCategory: 'indeterminate',
    storyPoints: 3,
    assigneeName: 'Asha',
    assigneeLogin: 'asha',
    epicKey: 'NHC-1',
    parentKey: null,
    ...overrides,
  };
}

function commit(sha: string, message: string, committedAt = '2026-11-03') {
  return {
    sha,
    repoFullName: 'org/app',
    message,
    authorLogin: 'asha',
    authorEmail: null,
    parentCount: 1,
    additions: 1,
    deletions: 0,
    committedAt: new Date(`${committedAt}T00:00:00.000Z`),
    authoredAt: new Date(`${committedAt}T00:00:00.000Z`),
  };
}

function pr(number: string, state: string) {
  return {
    repoFullName: 'org/app',
    externalNumber: number,
    state,
    openedAt: new Date('2026-11-02T00:00:00.000Z'),
    firstReviewAt: null,
    mergedAt: state === 'merged' ? new Date('2026-11-04T00:00:00.000Z') : null,
  };
}

describe('SprintHealthDetailService.workBreakdown', () => {
  let planning: jest.Mocked<PlanningService>;
  let code: jest.Mocked<CodeService>;
  let correlation: jest.Mocked<CorrelationService>;
  let service: SprintHealthDetailService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-06T00:00:00.000Z'));
    planning = {
      findSprintByExternalId: jest.fn(async (tenantId: string, id: string) =>
        tenantId === 't1' && id === '42' ? SPRINT : null,
      ),
      listItemsForSprint: jest.fn().mockResolvedValue([
        // Jira says QA; GitHub says merged — the commonest disagreement.
        item('NHC-10', { status: 'Ready for QA' }),
        item('NHC-11', { status: 'READY FOR UAT', statusCategory: 'done' }),
        item('NHC-12', {
          status: 'DEFINED',
          statusCategory: 'new',
          storyPoints: null,
          assigneeName: null,
          epicKey: null,
        }),
        item('NHC-13', { type: 'bug' }),
        item('NHC-20', {
          type: 'subtask',
          parentKey: 'NHC-13',
          status: 'Closed',
          statusCategory: 'done',
        }),
        item('NHC-1', { type: 'epic', title: 'Billing', epicKey: null }),
      ]),
      findByKeys: jest.fn(async (_t: string, keys: string[]) =>
        keys.includes('NHC-1')
          ? [{ externalKey: 'NHC-1', projectKey: 'NHC', title: 'Billing' }]
          : [],
      ),
    } as unknown as jest.Mocked<PlanningService>;

    code = {
      listCommitsPage: jest.fn().mockResolvedValue({
        commits: [
          commit('a', 'NHC-10 fix'),
          commit('b', 'NHC-10 tidy', '2026-11-05'),
          // A subtask's commit is its parent's code.
          commit('c', 'NHC-20 handle refund'),
          commit('d', 'no ticket here'),
        ],
        truncated: false,
      }),
      branchesForCommits: jest.fn().mockResolvedValue([]),
      listPullRequestsByRefs: jest
        .fn()
        .mockResolvedValue([pr('1', 'merged'), pr('2', 'open')]),
    } as unknown as jest.Mocked<CodeService>;

    correlation = {
      prRefsByStoryId: jest.fn().mockResolvedValue(
        new Map([
          ['id-NHC-10', ['org/app#1']],
          ['id-NHC-11', ['org/app#2']],
        ]),
      ),
    } as unknown as jest.Mocked<CorrelationService>;

    service = new SprintHealthDetailService(
      {
        requireTenantId: jest.fn().mockReturnValue('t1'),
      } as unknown as TenantContextService,
      {
        prReview: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService,
      planning,
      code,
      {} as unknown as DeveloperIdentityService,
      correlation,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('counts work items as the Jira board does — by status category, without epics or subtasks', async () => {
    const view = (await service.workBreakdown('42', ['NHC']))!;

    expect(view.tickets.map((t) => t.key)).toEqual([
      'NHC-10',
      'NHC-13',
      'NHC-12',
      'NHC-11',
    ]);
    // "READY FOR UAT" sits in Jira's done category, whatever its name says.
    expect(view.buckets).toEqual({
      todo: { items: 1, points: 0 },
      'in-progress': { items: 2, points: 6 },
      done: { items: 1, points: 3 },
    });
    expect(view.byType).toEqual([
      { type: 'story', items: 3, done: 1 },
      { type: 'bug', items: 1, done: 0 },
    ]);
    expect(view.subtasks).toEqual({ total: 1, done: 1 });
    expect(view.unestimated).toBe(1);
    expect(view.unassigned).toBe(1);
    expect(planning.listItemsForSprint).toHaveBeenCalledWith('t1', '42', [
      'NHC',
    ]);
  });

  it('takes code state from GitHub and flags where it disagrees with Jira, without overriding Jira', async () => {
    const view = (await service.workBreakdown('42', ['NHC']))!;
    const byKey = new Map(view.tickets.map((t) => [t.key, t]));

    const qa = byKey.get('NHC-10')!;
    expect(qa.code.state).toBe('merged');
    expect(qa.code.commits).toBe(2);
    expect(qa.code.lastCommitAt).toBe('2026-11-05T00:00:00.000Z');
    expect(qa.clash).toBe('github-ahead');
    // Jira keeps the workflow: still in progress, not counted done.
    expect(qa.bucket).toBe('in-progress');

    const uat = byKey.get('NHC-11')!;
    expect(uat.code.state).toBe('in-review');
    expect(uat.clash).toBe('jira-ahead');

    expect(byKey.get('NHC-13')!.code).toMatchObject({
      state: 'committed',
      commits: 1,
    });
    expect(byKey.get('NHC-12')!.code.state).toBe('none');
    expect(view.code).toEqual({
      merged: 1,
      'in-review': 1,
      committed: 1,
      none: 1,
    });
    expect(view.clashes).toEqual({ githubAhead: 1, jiraAhead: 1 });
  });

  it('groups by epic with its Jira title, biggest first and "no epic" last', async () => {
    const view = (await service.workBreakdown('42', ['NHC']))!;

    expect(view.epics).toEqual([
      { key: 'NHC-1', title: 'Billing', items: 3, done: 1, points: 9 },
      { key: null, title: null, items: 1, done: 0, points: 0 },
    ]);
  });

  it('reads the window once when the route asks every panel at the same time', async () => {
    await Promise.all([
      service.workBreakdown('42', ['NHC']),
      service.workBreakdown('42', ['NHC']),
    ]);

    expect(code.listCommitsPage).toHaveBeenCalledTimes(1);
  });

  describe('where Jira lags the GitHub work', () => {
    beforeEach(() => {
      planning.listItemsForSprint.mockResolvedValue([
        // Merged, nothing open, still "In Development": Jira not updated.
        item('NHC-30', { status: 'In Development' }),
        // Commits exist, Jira never started it.
        item('NHC-31', {
          status: 'READY FOR DEVELOPMENT',
          assigneeName: null,
        }),
        // Merged and waiting on QA: the expected flow.
        item('NHC-32', { status: 'Ready for QA' }),
        // In development, nothing names it.
        item('NHC-33', { status: 'In Development' }),
      ] as never);
      code.listCommitsPage.mockResolvedValue({
        commits: [
          commit('a', 'NHC-31 start'),
          commit('b', 'NHC-50 backlog work'),
          commit('c', 'NHC-50 more'),
          commit('d', 'NHC-60 carried over'),
          commit('e', 'NHC-99 typo or never logged'),
          commit('f', 'quick fix'),
          { ...commit('g', 'NHC-30 done'), repoFullName: 'org/app' },
        ],
        truncated: false,
      } as never);
      code.listPullRequestsByRefs.mockResolvedValue([
        pr('1', 'merged'),
        pr('3', 'merged'),
      ] as never);
      correlation.prRefsByStoryId.mockResolvedValue(
        new Map([
          ['id-NHC-30', ['org/app#1']],
          ['id-NHC-32', ['org/app#3']],
        ]),
      );
      planning.findByKeys.mockImplementation((async (
        _t: string,
        keys: string[],
      ) =>
        [
          { externalKey: 'NHC-50', projectKey: 'NHC', sprintExternalId: null },
          { externalKey: 'NHC-60', projectKey: 'NHC', sprintExternalId: '41' },
        ].filter((s) => keys.includes(s.externalKey))) as never);
    });

    it('names the flow that fixes each ticket, and reports QA as expected rather than stale', async () => {
      const view = (await service.workBreakdown('42', ['NHC']))!;
      const gapsOf = new Map(view.tickets.map((t) => [t.key, t.gaps]));

      expect(gapsOf.get('NHC-30')).toEqual(['jira-not-updated']);
      expect(gapsOf.get('NHC-31')).toEqual([
        'progress-not-marked',
        'unassigned-with-code',
      ]);
      expect(gapsOf.get('NHC-32')).toEqual(['in-qa']);
      expect(gapsOf.get('NHC-33')).toEqual(['no-code-linked']);
    });

    it('reads backlog, other-sprint, unlogged and untagged work from the commits', async () => {
      const view = (await service.workBreakdown('42', ['NHC']))!;
      const byKind = new Map(view.gaps.map((g) => [g.kind, g]));

      expect(byKind.get('ticket-not-in-sprint')).toMatchObject({
        count: 1,
        commits: 2,
        sample: ['NHC-50'],
      });
      expect(byKind.get('ticket-in-other-sprint')).toMatchObject({
        count: 1,
        sample: ['NHC-60'],
      });
      expect(byKind.get('ticket-not-logged')).toMatchObject({
        sample: ['NHC-99'],
      });
      expect(byKind.get('commits-not-tagged')).toMatchObject({
        count: 1,
        commits: 1,
        sample: ['org/app'],
      });
      expect(byKind.get('in-qa')!.severity).toBe('info');
      // Most actionable first, expected flow last.
      expect(view.gaps[0].kind).toBe('progress-not-marked');
      expect(view.gaps.at(-1)!.kind).toBe('in-qa');
    });
  });

  it("returns null for another tenant's sprint", async () => {
    planning.findSprintByExternalId.mockResolvedValue(null);

    expect(await service.workBreakdown('42', ['NHC'])).toBeNull();
    expect(planning.listItemsForSprint).not.toHaveBeenCalled();
  });
});
