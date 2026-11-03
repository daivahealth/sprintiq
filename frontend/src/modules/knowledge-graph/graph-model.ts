import type {
  ActivityCommit,
  ActivityPullRequest,
  ActivityReview,
  Attribution,
  DeveloperRepositoriesResponse,
  RepositoryActivitiesResponse,
  RepositoryDevelopersResponse,
  RepositoryRef,
} from './api';
import type { EntityType, RelationType } from './entity-registry';

/**
 * Turns knowledge-graph API responses into the nodes and edges the canvas
 * draws. Pure, so it is the part that is tested.
 *
 * The rule throughout: an edge is drawn only when a response states it.
 *  - DEVELOPER –contributed to→ REPOSITORY: a row in `developers` (or
 *    `repositories` from the reverse lookup).
 *  - DEVELOPER –created→ COMMIT / PR / REVIEW: the item's `author`, present
 *    only when `attribution === 'person'`. A withheld or unattributed item is
 *    drawn without one, and never gets an author from anywhere else.
 *  - COMMIT / PR –belongs to→ REPOSITORY: the item came from that
 *    repository's activities.
 *  - REVIEW –belongs to→ PR: the review's `prNumber`.
 *  - PR –references→ JIRA_ISSUE: the PR's `jiraKeys`, with confidence from
 *    the issue's `pullRequests` list.
 * Nothing links a commit to a Jira issue, because the backend does not.
 */

export type NodeDetail =
  | { kind: 'repository'; repository: RepositoryRef }
  | { kind: 'developer'; developerId: string; displayName: string }
  | { kind: 'commit'; repoId: string; commit: ActivityCommit }
  | {
      kind: 'pull_request';
      repoId: string;
      number: string;
      /** Null when only a review's `prNumber` named it (outside the loaded page). */
      pullRequest: ActivityPullRequest | null;
    }
  | { kind: 'review'; repoId: string; review: ActivityReview }
  | {
      kind: 'jira_issue';
      key: string;
      title: string;
      status: string;
      type: string;
    };

export interface VizNode {
  id: string;
  type: EntityType;
  label: string;
  detail: NodeDetail;
}

export interface VizEdge {
  id: string;
  source: string;
  target: string;
  relation: RelationType;
  confidence?: number;
  method?: string;
}

export interface GraphData {
  nodes: VizNode[];
  edges: VizEdge[];
}

/** Most activity nodes one expansion adds per type, newest first. */
export const EXPANSION_CAP = 15;

export const nodeIds = {
  repository: (repoId: string) => `REPOSITORY:${repoId}`,
  developer: (developerId: string) => `DEVELOPER:${developerId}`,
  commit: (repoId: string, sha: string) => `COMMIT:${repoId}@${sha}`,
  pullRequest: (repoId: string, number: string) =>
    `PULL_REQUEST:${repoId}#${number}`,
  /**
   * The API gives reviews no id, so one is composed from what it does give.
   * Two reviews by one author on one PR in the same second would collide;
   * recorded as an API gap (ANALYTICS.md §5.2).
   */
  review: (repoId: string, review: ActivityReview) =>
    `REVIEW:${repoId}#${review.prNumber}@${review.submittedAt}|${
      review.author?.developerId ?? review.attribution
    }`,
  jiraIssue: (key: string) => `JIRA_ISSUE:${key}`,
};

function edge(
  relation: RelationType,
  source: string,
  target: string,
  extra: Pick<VizEdge, 'confidence' | 'method'> = {},
): VizEdge {
  return { id: `${relation}|${source}|${target}`, source, target, relation, ...extra };
}

function repositoryNode(repository: RepositoryRef): VizNode {
  return {
    id: nodeIds.repository(repository.id),
    type: 'REPOSITORY',
    label: repository.fullName,
    detail: { kind: 'repository', repository },
  };
}

function developerNode(developerId: string, displayName: string): VizNode {
  return {
    id: nodeIds.developer(developerId),
    type: 'DEVELOPER',
    label: displayName,
    detail: { kind: 'developer', developerId, displayName },
  };
}

function pullRequestNode(
  repoId: string,
  number: string,
  pullRequest: ActivityPullRequest | null,
): VizNode {
  return {
    id: nodeIds.pullRequest(repoId, number),
    type: 'PULL_REQUEST',
    label: `#${number}`,
    detail: { kind: 'pull_request', repoId, number, pullRequest },
  };
}

/** The author edge, when — and only when — the backend attributed the item. */
function authorEdge(item: Attribution, target: string): {
  nodes: VizNode[];
  edges: VizEdge[];
} {
  if (item.attribution !== 'person') {
    return { nodes: [], edges: [] };
  }
  const author = developerNode(item.author.developerId, item.author.displayName);
  return { nodes: [author], edges: [edge('CREATED', author.id, target)] };
}

/** Repository focus: the repository and the developers the backend returned. */
export function repositoryGraph(view: RepositoryDevelopersResponse): GraphData {
  const repo = repositoryNode(view.repository);
  const developers = view.developers.map((d) =>
    developerNode(d.developerId, d.displayName),
  );
  return {
    nodes: [repo, ...developers],
    edges: developers.map((d) => edge('CONTRIBUTED_TO', d.id, repo.id)),
  };
}

/** Developer focus: the developer and the repositories they worked in. */
export function developerGraph(view: DeveloperRepositoriesResponse): GraphData {
  const developer = developerNode(
    view.developer.developerId,
    view.developer.displayName,
  );
  const repos = view.repositories.map((r) =>
    repositoryNode({ id: r.id, fullName: r.fullName, url: r.url }),
  );
  return {
    nodes: [developer, ...repos],
    edges: repos.map((r) => edge('CONTRIBUTED_TO', developer.id, r.id)),
  };
}

function commitPiece(repoId: string, commit: ActivityCommit): GraphData {
  const node: VizNode = {
    id: nodeIds.commit(repoId, commit.sha),
    type: 'COMMIT',
    label: commit.sha.slice(0, 7),
    detail: { kind: 'commit', repoId, commit },
  };
  const author = authorEdge(commit, node.id);
  return {
    nodes: [node, ...author.nodes],
    edges: [edge('BELONGS_TO', node.id, nodeIds.repository(repoId)), ...author.edges],
  };
}

function pullRequestPiece(
  repoId: string,
  pr: ActivityPullRequest,
  activities: RepositoryActivitiesResponse,
): GraphData {
  const node = pullRequestNode(repoId, pr.number, pr);
  const author = authorEdge(pr, node.id);
  const nodes = [node, ...author.nodes];
  const edges = [
    edge('BELONGS_TO', node.id, nodeIds.repository(repoId)),
    ...author.edges,
  ];
  for (const key of pr.jiraKeys) {
    const issue = activities.jiraIssues.items.find((i) => i.key === key);
    const link = issue?.pullRequests.find((p) => p.number === pr.number);
    const issueId = nodeIds.jiraIssue(key);
    nodes.push({
      id: issueId,
      type: 'JIRA_ISSUE',
      label: key,
      detail: {
        kind: 'jira_issue',
        key,
        // The issue list is capped too; a key beyond it is still a real link.
        title: issue?.title ?? '',
        status: issue?.status ?? '',
        type: issue?.type ?? '',
      },
    });
    edges.push(
      edge('REFERENCES', node.id, issueId, {
        confidence: link?.confidence,
        method: link?.method,
      }),
    );
  }
  return { nodes, edges };
}

function reviewPiece(
  repoId: string,
  review: ActivityReview,
  activities: RepositoryActivitiesResponse,
): GraphData {
  const node: VizNode = {
    id: nodeIds.review(repoId, review),
    type: 'REVIEW',
    label: review.state.replace(/_/g, ' '),
    detail: { kind: 'review', repoId, review },
  };
  const pr =
    activities.pullRequests.items.find((p) => p.number === review.prNumber) ??
    null;
  const prNode = pullRequestNode(repoId, review.prNumber, pr);
  const author = authorEdge(review, node.id);
  return {
    nodes: [node, prNode, ...author.nodes],
    edges: [edge('BELONGS_TO', node.id, prNode.id), ...author.edges],
  };
}

function newestFirst<T>(items: T[], at: (item: T) => string, cap: number): T[] {
  return [...items].sort((a, b) => at(b).localeCompare(at(a))).slice(0, cap);
}

/**
 * One developer's activity in a repository, from that repository's
 * activities page. Only items the backend attributed to them, newest first,
 * capped per type so the canvas stays readable.
 */
export function developerActivityExpansion(
  activities: RepositoryActivitiesResponse,
  developerId: string,
  cap = EXPANSION_CAP,
): GraphData & { shown: Record<'commits' | 'pullRequests' | 'reviews', number> } {
  const repoId = activities.repository.id;
  const mine = <T extends Attribution>(items: T[]) =>
    items.filter(
      (i) => i.attribution === 'person' && i.author.developerId === developerId,
    );
  const commits = newestFirst(
    mine(activities.commits.items),
    (c) => c.authoredAt,
    cap,
  );
  const prs = newestFirst(
    mine(activities.pullRequests.items),
    (p) => p.mergedAt ?? p.openedAt ?? '',
    cap,
  );
  const reviews = newestFirst(
    mine(activities.reviews.items),
    (r) => r.submittedAt,
    cap,
  );
  const pieces = [
    ...commits.map((c) => commitPiece(repoId, c)),
    ...prs.map((p) => pullRequestPiece(repoId, p, activities)),
    ...reviews.map((r) => reviewPiece(repoId, r, activities)),
  ];
  return {
    ...mergeGraphs(...pieces),
    shown: {
      commits: commits.length,
      pullRequests: prs.length,
      reviews: reviews.length,
    },
  };
}

/** A PR's reviews (by anyone) and its linked Jira issues. */
export function pullRequestExpansion(
  activities: RepositoryActivitiesResponse,
  prNumber: string,
): GraphData {
  const repoId = activities.repository.id;
  const pr = activities.pullRequests.items.find((p) => p.number === prNumber);
  const pieces: GraphData[] = pr
    ? [pullRequestPiece(repoId, pr, activities)]
    : [{ nodes: [pullRequestNode(repoId, prNumber, null)], edges: [] }];
  for (const review of activities.reviews.items) {
    if (review.prNumber === prNumber) {
      pieces.push(reviewPiece(repoId, review, activities));
    }
  }
  return mergeGraphs(...pieces);
}

/** A single activity record, revealed from the activity tables. */
export function activityItemExpansion(
  activities: RepositoryActivitiesResponse,
  item: ActivityItemRef,
): GraphData {
  const repoId = activities.repository.id;
  switch (item.kind) {
    case 'commit': {
      const commit = activities.commits.items.find((c) => c.sha === item.sha);
      return commit ? commitPiece(repoId, commit) : emptyGraph();
    }
    case 'pull_request':
      return pullRequestExpansion(activities, item.number);
    case 'jira_issue': {
      const issue = activities.jiraIssues.items.find((i) => i.key === item.key);
      return mergeGraphs(
        ...(issue?.pullRequests ?? []).map((p) =>
          pullRequestExpansion(activities, p.number),
        ),
      );
    }
  }
}

export type ActivityItemRef =
  | { kind: 'commit'; sha: string }
  | { kind: 'pull_request'; number: string }
  | { kind: 'jira_issue'; key: string };

/** What the user has expanded on top of the focus graph. */
export interface Expansions {
  developers: string[];
  pullRequests: string[];
  items: ActivityItemRef[];
}

export const NO_EXPANSIONS: Expansions = {
  developers: [],
  pullRequests: [],
  items: [],
};

export function hasExpansions(e: Expansions): boolean {
  return e.developers.length + e.pullRequests.length + e.items.length > 0;
}

/**
 * The graph on screen: the focus graph plus every expansion the activities
 * response can satisfy. Expansions waiting on activities simply add nothing
 * yet, rather than inventing placeholders.
 */
export function composeGraph(
  base: GraphData,
  activities: RepositoryActivitiesResponse | undefined,
  expansions: Expansions,
): GraphData {
  if (!activities) {
    return base;
  }
  return mergeGraphs(
    base,
    ...expansions.developers.map((d) =>
      developerActivityExpansion(activities, d),
    ),
    ...expansions.pullRequests.map((n) => pullRequestExpansion(activities, n)),
    ...expansions.items.map((i) => activityItemExpansion(activities, i)),
  );
}

/**
 * Union by id. A PR known only by number is replaced by the full record when
 * another piece carries it; otherwise the first occurrence wins, so the focus
 * graph's own nodes keep their place.
 */
export function mergeGraphs(...graphs: GraphData[]): GraphData {
  const nodes = new Map<string, VizNode>();
  const edges = new Map<string, VizEdge>();
  for (const g of graphs) {
    for (const node of g.nodes) {
      const existing = nodes.get(node.id);
      if (!existing || isPlaceholder(existing, node)) {
        nodes.set(node.id, node);
      }
    }
    for (const e of g.edges) {
      if (!edges.has(e.id)) {
        edges.set(e.id, e);
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function isPlaceholder(existing: VizNode, incoming: VizNode): boolean {
  return (
    existing.detail.kind === 'pull_request' &&
    existing.detail.pullRequest === null &&
    incoming.detail.kind === 'pull_request' &&
    incoming.detail.pullRequest !== null
  );
}

export function emptyGraph(): GraphData {
  return { nodes: [], edges: [] };
}
