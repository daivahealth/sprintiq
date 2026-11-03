import {
  CommitRecord,
  DeveloperRef,
  developerKey,
  EdgeType,
  edgeKey,
  IssueRecord,
  nodeKey,
  NodeType,
  PullRequestRecord,
  repositoryKey,
} from './knowledge-graph.types';
import { TenantGraph } from './tenant-graph';

const asha: DeveloperRef = {
  developerId: 'asha',
  displayName: 'Asha',
  excluded: false,
};
const ravi: DeveloperRef = {
  developerId: 'ravi',
  displayName: 'Ravi',
  excluded: false,
};

function commit(over: Partial<CommitRecord> = {}): CommitRecord {
  return {
    id: 'c1',
    repoFullName: 'acme/billing',
    sha: 'aaa111',
    authoredAt: new Date('2026-10-01T10:00:00Z'),
    parentCount: 1,
    author: asha,
    ...over,
  };
}

const issue: IssueRecord = {
  id: 's1',
  key: 'PAY-1',
  title: 'Invoice generation',
  status: 'In Progress',
  type: 'story',
};

function pr(over: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    id: 'p1',
    repoFullName: 'acme/billing',
    number: '7',
    title: 'PAY-1 invoices',
    state: 'merged',
    openedAt: new Date('2026-10-02T09:00:00Z'),
    mergedAt: new Date('2026-10-03T09:00:00Z'),
    author: asha,
    reviews: [
      {
        id: 'r1',
        repoFullName: 'acme/billing',
        prNumber: '7',
        state: 'approved',
        submittedAt: new Date('2026-10-02T15:00:00Z'),
        isBot: false,
        reviewer: ravi,
      },
    ],
    issueLinks: [{ issue, confidence: 0.8, method: 'regex' }],
    ...over,
  };
}

const repo = repositoryKey('acme/billing');
const ashaKey = developerKey('asha');
const raviKey = developerKey('ravi');
const prKey = nodeKey(NodeType.PULL_REQUEST, 'p1');

describe('TenantGraph', () => {
  it('builds typed nodes and the source and derived edges from a snapshot', () => {
    const g = new TenantGraph('t1');
    g.load({ commits: [commit()], pullRequests: [pr()], issues: [] });

    const { graph } = g;
    expect(graph.hasEdge(edgeKey(EdgeType.CREATED, ashaKey, 'COMMIT:c1'))).toBe(
      true,
    );
    expect(graph.hasEdge(edgeKey(EdgeType.BELONGS_TO, 'COMMIT:c1', repo))).toBe(
      true,
    );
    expect(
      graph.hasEdge(edgeKey(EdgeType.REFERENCES, prKey, 'JIRA_ISSUE:s1')),
    ).toBe(true);
    expect(
      graph.getEdgeAttributes(edgeKey(EdgeType.REVIEWED, raviKey, prKey)),
    ).toEqual({
      type: EdgeType.REVIEWED,
      count: 1,
      lastAt: '2026-10-02T15:00:00.000Z',
    });
    // Asha's latest contribution is the merge, not the earlier commit.
    expect(
      graph.getEdgeAttributes(edgeKey(EdgeType.CONTRIBUTED_TO, ashaKey, repo))
        .lastAt,
    ).toBe('2026-10-03T09:00:00.000Z');
    // A reviewer contributes to the repo too.
    expect(graph.hasEdge(edgeKey(EdgeType.CONTRIBUTED_TO, raviKey, repo))).toBe(
      true,
    );
  });

  it('reports every node type, including the reserved ones, in its stats', () => {
    const g = new TenantGraph('t1');
    g.load({ commits: [commit()], pullRequests: [], issues: [] });
    const stats = g.stats();
    expect(stats.nodesByType).toMatchObject({
      COMMIT: 1,
      DEVELOPER: 1,
      REPOSITORY: 1,
      TEAM: 0,
      FEATURE: 0,
    });
    expect(stats.nodes).toBe(3);
  });

  it('is idempotent: re-applying the same rows leaves the graph unchanged', () => {
    const g = new TenantGraph('t1');
    g.load({ commits: [commit()], pullRequests: [pr()], issues: [] });
    const before = g.stats();
    g.upsertCommit(commit());
    g.upsertPullRequest(pr());
    g.upsertPullRequest(pr());
    expect(g.stats()).toEqual(before);
  });

  it('agrees with a bulk load when the same rows arrive one at a time', () => {
    const bulk = new TenantGraph('t1');
    bulk.load({ commits: [commit()], pullRequests: [pr()], issues: [] });
    const incremental = new TenantGraph('t1');
    incremental.upsertPullRequest(pr());
    incremental.upsertCommit(commit());
    expect(incremental.stats()).toEqual(bulk.stats());
  });

  it('moves authorship when a corrected row is re-read, and drops the stranded developer', () => {
    const g = new TenantGraph('t1');
    g.load({ commits: [commit()], pullRequests: [], issues: [] });
    g.upsertCommit(commit({ author: ravi }));

    expect(g.graph.hasNode(ashaKey)).toBe(false);
    expect(
      g.graph.hasEdge(edgeKey(EdgeType.CONTRIBUTED_TO, raviKey, repo)),
    ).toBe(true);
  });

  it('removes a review, its REVIEWED edge and the contribution it carried when the PR no longer has it', () => {
    const g = new TenantGraph('t1');
    g.load({ commits: [], pullRequests: [pr()], issues: [] });
    g.upsertPullRequest(pr({ reviews: [] }));

    expect(g.graph.hasNode('REVIEW:r1')).toBe(false);
    expect(g.graph.hasEdge(edgeKey(EdgeType.REVIEWED, raviKey, prKey))).toBe(
      false,
    );
    expect(g.graph.hasNode(raviKey)).toBe(false);
  });

  it('drops a dropped correlation link, and the issue with it unless something else holds it', () => {
    const g = new TenantGraph('t1');
    g.load({ commits: [], pullRequests: [pr()], issues: [] });
    g.upsertPullRequest(pr({ issueLinks: [] }));
    expect(g.graph.hasNode('JIRA_ISSUE:s1')).toBe(false);

    const held = new TenantGraph('t1');
    held.load({
      commits: [],
      pullRequests: [pr()],
      issues: [{ ...issue, assignee: asha }],
    });
    held.upsertPullRequest(pr({ issueLinks: [] }));
    expect(held.graph.hasNode('JIRA_ISSUE:s1')).toBe(true);
    expect(
      held.graph.hasEdge(
        edgeKey(EdgeType.ASSIGNED_TO, 'JIRA_ISSUE:s1', ashaKey),
      ),
    ).toBe(true);
  });

  it('drops an issue once it has neither a PR link nor a resolved assignee', () => {
    const g = new TenantGraph('t1');
    g.load({
      commits: [],
      pullRequests: [],
      issues: [{ ...issue, assignee: asha }],
    });
    g.upsertIssue({ ...issue, assignee: undefined });
    expect(g.stats().nodes).toBe(0);
  });

  it('keeps an unattributed commit on its repo with no developer edge', () => {
    const g = new TenantGraph('t1');
    g.load({
      commits: [commit({ author: undefined })],
      pullRequests: [],
      issues: [],
    });
    expect(g.graph.inDegree('COMMIT:c1')).toBe(0);
    expect(g.graph.hasNode(repo)).toBe(true);
  });

  it('removes a commit by natural key and drops the repo once nothing is left in it', () => {
    const g = new TenantGraph('t1');
    g.load({
      commits: [commit({ author: undefined })],
      pullRequests: [],
      issues: [],
    });
    g.removeCommit('ACME/Billing', 'aaa111');
    expect(g.stats().nodes).toBe(0);
  });

  it('removes a PR together with its reviews', () => {
    const g = new TenantGraph('t1');
    g.load({ commits: [commit()], pullRequests: [pr()], issues: [] });
    g.removePullRequest('acme/billing', '7');

    expect(g.graph.hasNode(prKey)).toBe(false);
    expect(g.graph.hasNode('REVIEW:r1')).toBe(false);
    expect(g.graph.hasNode(raviKey)).toBe(false);
    // Asha still has the commit, so her contribution survives.
    expect(
      g.graph.getEdgeAttributes(edgeKey(EdgeType.CONTRIBUTED_TO, ashaKey, repo))
        .lastAt,
    ).toBe('2026-10-01T10:00:00.000Z');
  });

  it('treats repository names case-insensitively, as GitHub does', () => {
    const g = new TenantGraph('t1');
    g.load({
      commits: [
        commit(),
        commit({ id: 'c2', sha: 'b', repoFullName: 'Acme/Billing' }),
      ],
      pullRequests: [],
      issues: [],
    });
    expect(g.stats().nodesByType.REPOSITORY).toBe(1);
  });

  it('flags automation and anonymized accounts on the developer node', () => {
    const g = new TenantGraph('t1');
    g.load({
      commits: [
        commit({
          author: { ...asha, developerId: 'dependabot[bot]' },
        }),
      ],
      pullRequests: [],
      issues: [],
    });
    expect(
      g.graph.getNodeAttributes(developerKey('dependabot[bot]')),
    ).toMatchObject({ isBot: true, isAnonymized: false });
  });
});
