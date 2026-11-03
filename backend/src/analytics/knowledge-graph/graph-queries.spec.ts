import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  developerRepositories,
  repositoryActivities,
  repositoryDevelopers,
  resolveRepository,
  searchRepositories,
} from './graph-queries';
import {
  CommitRecord,
  DeveloperRef,
  PullRequestRecord,
  repositoryKey,
} from './knowledge-graph.types';
import { TenantGraph } from './tenant-graph';

const dev = (
  developerId: string,
  displayName: string,
  excluded = false,
): DeveloperRef => ({ developerId, displayName, excluded });
const asha = dev('asha', 'Asha');
const ravi = dev('ravi', 'Ravi');
const zed = dev('zed', 'Zed', true);
const bot = dev('dependabot[bot]', 'Dependabot');

let seq = 0;
function commit(
  author: DeveloperRef | undefined,
  day: number,
  repoFullName = 'acme/billing',
): CommitRecord {
  seq++;
  return {
    id: `c${seq}`,
    repoFullName,
    sha: `sha${seq}`,
    authoredAt: new Date(Date.UTC(2026, 9, day)),
    parentCount: 1,
    author,
  };
}

const pr: PullRequestRecord = {
  id: 'p1',
  repoFullName: 'acme/billing',
  number: '7',
  title: 'PAY-1 invoices',
  state: 'merged',
  openedAt: new Date('2026-10-05T09:00:00Z'),
  mergedAt: new Date('2026-10-06T09:00:00Z'),
  author: asha,
  reviews: [
    {
      id: 'r1',
      repoFullName: 'acme/billing',
      prNumber: '7',
      state: 'approved',
      submittedAt: new Date('2026-10-05T15:00:00Z'),
      isBot: false,
      reviewer: ravi,
    },
    {
      id: 'r2',
      repoFullName: 'acme/billing',
      prNumber: '7',
      state: 'commented',
      submittedAt: new Date('2026-10-05T16:00:00Z'),
      isBot: true,
      reviewer: bot,
    },
  ],
  issueLinks: [
    {
      issue: {
        id: 's1',
        key: 'PAY-1',
        title: 'Invoice generation',
        status: 'Done',
        type: 'story',
      },
      confidence: 0.8,
      method: 'regex',
    },
  ],
};

function build(): TenantGraph {
  seq = 0;
  const g = new TenantGraph('t1');
  g.load({
    commits: [
      commit(asha, 1),
      // Ravi has more commits than Asha: an ordering by volume would put him
      // first, which is exactly what must not happen.
      commit(ravi, 2),
      commit(ravi, 3),
      commit(ravi, 4),
      commit(bot, 2),
      commit(zed, 2),
      commit(undefined, 2),
      commit(asha, 9, 'acme/billing-api'),
      commit(ravi, 1, 'other/billing-api'),
    ],
    pullRequests: [pr],
    issues: [
      {
        id: 's2',
        key: 'PAY-2',
        title: 'Credit notes',
        status: 'To Do',
        type: 'task',
        assignee: asha,
      },
    ],
  });
  return g;
}

describe('knowledge graph queries', () => {
  describe('searchRepositories', () => {
    it('matches on name or URL and returns alphabetically, capped', () => {
      const g = build();
      expect(
        searchRepositories(g, 'BILLING', 10).map((r) => r.fullName),
      ).toEqual(['acme/billing', 'acme/billing-api', 'other/billing-api']);
      expect(searchRepositories(g, 'github.com/other', 10)).toHaveLength(1);
      expect(searchRepositories(g, 'billing', 1)).toHaveLength(1);
      expect(searchRepositories(g, 'billing', 10)[0]).toMatchObject({
        id: 'acme/billing',
        commitCount: 7,
        pullRequestCount: 1,
      });
    });

    it('rejects an empty query', () => {
      expect(() => searchRepositories(build(), '  ', 10)).toThrow(
        BadRequestException,
      );
    });
  });

  describe('resolveRepository', () => {
    it('resolves by id in any case, by URL, and by a unique bare name', () => {
      const g = build();
      const key = repositoryKey('acme/billing');
      expect(resolveRepository(g, 'ACME/Billing')).toBe(key);
      expect(resolveRepository(g, 'https://github.com/acme/billing.git')).toBe(
        key,
      );
      expect(resolveRepository(g, 'billing')).toBe(key);
    });

    it('refuses to guess between same-named repos, and 404s an unknown one', () => {
      const g = build();
      expect(() => resolveRepository(g, 'billing-api')).toThrow(
        ConflictException,
      );
      // The candidates travel in the message: the error envelope keeps only it.
      expect(() => resolveRepository(g, 'billing-api')).toThrow(
        'acme/billing-api, other/billing-api',
      );
      expect(() => resolveRepository(g, 'acme/ledger')).toThrow(
        NotFoundException,
      );
    });
  });

  describe('repositoryDevelopers', () => {
    it('lists people alphabetically, never by volume', () => {
      const view = repositoryDevelopers(build(), repositoryKey('acme/billing'));
      expect(view.developers.map((d) => d.displayName)).toEqual([
        'Asha',
        'Ravi',
      ]);
      expect(view.developers[0]).toEqual({
        developerId: 'asha',
        displayName: 'Asha',
        commitCount: 1,
        pullRequestCount: 1,
        reviewCount: 0,
        lastContributionAt: '2026-10-06T09:00:00.000Z',
      });
      expect(view.developers[1]).toMatchObject({
        commitCount: 3,
        reviewCount: 1,
      });
    });

    it('keeps withheld and unattributed work in totals without naming anyone', () => {
      const view = repositoryDevelopers(build(), repositoryKey('acme/billing'));
      expect(view.totals).toEqual({ commits: 7, pullRequests: 1, reviews: 2 });
      expect(view.unattributed).toEqual({
        commits: 1,
        pullRequests: 0,
        reviews: 0,
      });
      expect(view.withheld).toEqual({
        commits: 2,
        pullRequests: 0,
        reviews: 1,
        identities: 2,
      });
      const named = view.developers.map((d) => d.developerId);
      expect(named).not.toContain('zed');
      expect(named).not.toContain('dependabot[bot]');
    });
  });

  describe('developerRepositories', () => {
    it('returns each repo the developer worked in, with their commits, PRs, reviews and issues', () => {
      const view = developerRepositories(build(), 'asha', 5);
      expect(view.repositories.map((r) => r.fullName)).toEqual([
        'acme/billing',
        'acme/billing-api',
      ]);
      expect(view.repositories[0]).toMatchObject({
        commitCount: 1,
        pullRequestsCreated: 1,
        pullRequestsReviewed: 0,
        jiraIssues: [expect.objectContaining({ key: 'PAY-1' })],
      });
      expect(view.assignedIssues.map((i) => i.key)).toEqual(['PAY-2']);
    });

    it('credits a reviewer with the PRs they reviewed, and caps recent commits newest-first', () => {
      const view = developerRepositories(build(), 'ravi', 2);
      const billing = view.repositories.find(
        (r) => r.fullName === 'acme/billing',
      );
      expect(billing).toMatchObject({
        commitCount: 3,
        pullRequestsReviewed: 1,
        reviewCount: 1,
        jiraIssues: [expect.objectContaining({ key: 'PAY-1' })],
      });
      expect(billing?.recentCommits.map((c) => c.authoredAt)).toEqual([
        '2026-10-04T00:00:00.000Z',
        '2026-10-03T00:00:00.000Z',
      ]);
    });

    it('never names a withheld identity, and 404s someone with no activity', () => {
      const g = build();
      expect(() => developerRepositories(g, 'zed', 5)).toThrow(
        NotFoundException,
      );
      expect(() => developerRepositories(g, 'dependabot[bot]', 5)).toThrow(
        NotFoundException,
      );
      expect(() => developerRepositories(g, 'nobody', 5)).toThrow(
        NotFoundException,
      );
    });
  });

  describe('repositoryActivities', () => {
    it('returns commits newest-first with attribution, and links issues to their PRs', () => {
      const view = repositoryActivities(
        build(),
        repositoryKey('acme/billing'),
        3,
      );
      expect(view.commits.total).toBe(7);
      expect(view.commits.items.map((c) => c.authoredAt)).toEqual([
        '2026-10-04T00:00:00.000Z',
        '2026-10-03T00:00:00.000Z',
        '2026-10-02T00:00:00.000Z',
      ]);
      expect(view.pullRequests.items[0]).toMatchObject({
        number: '7',
        jiraKeys: ['PAY-1'],
        attribution: 'person',
        author: { developerId: 'asha', displayName: 'Asha' },
      });
      expect(view.reviews.items.map((r) => r.attribution).sort()).toEqual([
        'person',
        'withheld',
      ]);
      expect(view.jiraIssues.items).toEqual([
        {
          key: 'PAY-1',
          title: 'Invoice generation',
          status: 'Done',
          type: 'story',
          pullRequests: [{ number: '7', confidence: 0.8, method: 'regex' }],
        },
      ]);
    });

    it('marks unattributed and withheld commits without naming them', () => {
      const view = repositoryActivities(
        build(),
        repositoryKey('acme/billing'),
        50,
      );
      const states = view.commits.items.map((c) => c.attribution);
      expect(states.filter((s) => s === 'unattributed')).toHaveLength(1);
      expect(states.filter((s) => s === 'withheld')).toHaveLength(2);
      for (const c of view.commits.items) {
        if (c.attribution !== 'person') {
          expect(c.author).toBeNull();
        }
      }
    });
  });
});
