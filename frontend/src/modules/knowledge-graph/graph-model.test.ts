import { describe, expect, it } from 'vitest';
import {
  activitiesResponse,
  developerReposResponse,
  developersResponse,
} from './fixtures';
import {
  activityItemExpansion,
  composeGraph,
  developerActivityExpansion,
  developerGraph,
  hasExpansions,
  NO_EXPANSIONS,
  nodeIds,
  pullRequestExpansion,
  repositoryGraph,
  type GraphData,
} from './graph-model';

const REPO = nodeIds.repository('acme/invoice-service');
const ASHA = nodeIds.developer('asha');
const DEV = nodeIds.developer('dev');

const edgeIds = (g: GraphData) => g.edges.map((e) => e.id).sort();
const nodeIdsOf = (g: GraphData) => g.nodes.map((n) => n.id);

describe('repositoryGraph', () => {
  it('draws the repository and exactly the developers the backend returned', () => {
    const g = repositoryGraph(developersResponse());
    expect(nodeIdsOf(g)).toEqual([REPO, ASHA, DEV]);
    expect(edgeIds(g)).toEqual([
      `CONTRIBUTED_TO|${ASHA}|${REPO}`,
      `CONTRIBUTED_TO|${DEV}|${REPO}`,
    ]);
  });

  it("keeps the backend's alphabetical order, even though Dev Kumar has more commits", () => {
    const g = repositoryGraph(developersResponse());
    expect(g.nodes.filter((n) => n.type === 'DEVELOPER').map((n) => n.label)).toEqual([
      'Asha Rao',
      'Dev Kumar',
    ]);
  });

  it('adds no node for withheld or unattributed work — those are counts, not people', () => {
    const g = repositoryGraph(developersResponse());
    expect(g.nodes.filter((n) => n.type === 'DEVELOPER')).toHaveLength(2);
  });

  it('draws an empty repository as just the repository', () => {
    const g = repositoryGraph(developersResponse({ developers: [] }));
    expect(nodeIdsOf(g)).toEqual([REPO]);
    expect(g.edges).toEqual([]);
  });
});

describe('developerGraph (reverse lookup)', () => {
  it('draws the developer and each repository they worked in', () => {
    const g = developerGraph(developerReposResponse());
    expect(nodeIdsOf(g)).toEqual([
      ASHA,
      REPO,
      nodeIds.repository('acme/ledger'),
    ]);
    expect(g.edges.every((e) => e.relation === 'CONTRIBUTED_TO' && e.source === ASHA)).toBe(true);
  });

  it("does not draw the per-repository Jira list as a developer → issue edge (the backend gives none)", () => {
    const g = developerGraph(developerReposResponse());
    expect(g.nodes.some((n) => n.type === 'JIRA_ISSUE')).toBe(false);
  });
});

describe('developerActivityExpansion', () => {
  it("adds only the work the backend attributed to that developer", () => {
    const g = developerActivityExpansion(activitiesResponse(), 'asha');
    expect(g.shown).toEqual({ commits: 1, pullRequests: 1, reviews: 0 });
    expect(edgeIds(g)).toEqual(
      [
        `BELONGS_TO|COMMIT:acme/invoice-service@aaaaaaa1111|${REPO}`,
        `CREATED|${ASHA}|COMMIT:acme/invoice-service@aaaaaaa1111`,
        `BELONGS_TO|PULL_REQUEST:acme/invoice-service#312|${REPO}`,
        `CREATED|${ASHA}|PULL_REQUEST:acme/invoice-service#312`,
        `REFERENCES|PULL_REQUEST:acme/invoice-service#312|JIRA_ISSUE:BILL-482`,
      ].sort(),
    );
  });

  it('links a PR to its Jira issue with the correlation confidence and method', () => {
    const g = developerActivityExpansion(activitiesResponse(), 'asha');
    const link = g.edges.find((e) => e.relation === 'REFERENCES');
    expect(link).toMatchObject({ confidence: 0.8, method: 'regex' });
  });

  it('never links a commit to a Jira issue', () => {
    const g = developerActivityExpansion(activitiesResponse(), 'asha');
    const commitIds = new Set(g.nodes.filter((n) => n.type === 'COMMIT').map((n) => n.id));
    expect(
      g.edges.some((e) => e.relation === 'REFERENCES' && commitIds.has(e.source)),
    ).toBe(false);
  });

  it("connects a reviewer's review to its PR, even when the PR is outside the loaded page", () => {
    const g = developerActivityExpansion(activitiesResponse(), 'dev');
    const outside = g.nodes.find((n) => n.id === nodeIds.pullRequest('acme/invoice-service', '298'));
    expect(outside?.detail).toMatchObject({ kind: 'pull_request', pullRequest: null });
    expect(g.edges.some((e) => e.relation === 'BELONGS_TO' && e.target === outside?.id)).toBe(true);
  });

  it('caps each type, newest first', () => {
    const g = developerActivityExpansion(activitiesResponse(), 'dev', 1);
    expect(g.shown.reviews).toBe(1);
    expect(g.nodes.filter((n) => n.type === 'REVIEW').map((n) => n.detail)).toEqual([
      expect.objectContaining({ review: expect.objectContaining({ submittedAt: '2026-10-30T11:00:00.000Z' }) }),
    ]);
  });
});

describe('pullRequestExpansion', () => {
  it("shows every review on the PR, without inventing an author for a withheld one", () => {
    const g = pullRequestExpansion(activitiesResponse(), '312');
    const reviews = g.nodes.filter((n) => n.type === 'REVIEW');
    expect(reviews).toHaveLength(2);
    const authored = g.edges.filter(
      (e) => e.relation === 'CREATED' && reviews.some((r) => r.id === e.target),
    );
    expect(authored).toEqual([expect.objectContaining({ source: DEV })]);
    // The withheld identity is never a node.
    expect(g.nodes.filter((n) => n.type === 'DEVELOPER').map((n) => n.id).sort()).toEqual([ASHA, DEV]);
  });
});

describe('activityItemExpansion', () => {
  it('reveals an unattributed commit on its repository with no author edge', () => {
    const g = activityItemExpansion(activitiesResponse(), { kind: 'commit', sha: 'ddddddd4444' });
    expect(g.edges.map((e) => e.relation)).toEqual(['BELONGS_TO']);
    expect(g.nodes.map((n) => n.type)).toEqual(['COMMIT']);
  });

  it('reveals a Jira issue through the PRs that reference it', () => {
    const g = activityItemExpansion(activitiesResponse(), { kind: 'jira_issue', key: 'BILL-482' });
    expect(g.nodes.some((n) => n.id === 'JIRA_ISSUE:BILL-482')).toBe(true);
    expect(g.edges.some((e) => e.relation === 'REFERENCES')).toBe(true);
  });
});

describe('composeGraph (expansion and reset)', () => {
  const base = repositoryGraph(developersResponse());

  it('is the focus graph alone until activities arrive', () => {
    expect(
      composeGraph(base, undefined, { ...NO_EXPANSIONS, developers: ['asha'] }),
    ).toBe(base);
  });

  it('adds expansions on top without duplicating shared nodes', () => {
    const g = composeGraph(base, activitiesResponse(), {
      ...NO_EXPANSIONS,
      developers: ['asha'],
      pullRequests: ['312'],
    });
    const ids = nodeIdsOf(g);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 3)).toEqual([REPO, ASHA, DEV]);
    expect(ids).toContain('JIRA_ISSUE:BILL-482');
  });

  it('upgrades a PR known only by number once its record is loaded', () => {
    const g = composeGraph(base, activitiesResponse(), {
      ...NO_EXPANSIONS,
      developers: ['dev'],
      pullRequests: ['312'],
    });
    const pr = g.nodes.find((n) => n.id === nodeIds.pullRequest('acme/invoice-service', '312'));
    expect(pr?.detail).toMatchObject({ pullRequest: expect.objectContaining({ title: 'BILL-482 credit-note invoices' }) });
  });

  it('returns exactly the focus graph after a reset', () => {
    expect(composeGraph(base, activitiesResponse(), NO_EXPANSIONS)).toEqual(base);
    expect(hasExpansions(NO_EXPANSIONS)).toBe(false);
  });
});
