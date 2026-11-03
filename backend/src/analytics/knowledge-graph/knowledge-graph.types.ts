/**
 * Node and edge model for the in-memory knowledge graph (BC-10,
 * docs/features/ANALYTICS.md §2).
 *
 * The graph is a derived projection of rows Postgres already holds — never a
 * second source of truth. Node attributes are the small subset traversal and
 * responses need; messages, LOC and file lists stay in Postgres.
 */

export const NodeType = {
  DEVELOPER: 'DEVELOPER',
  /** Reserved: SprintIQ stores no team membership yet (DATA-MODEL.md §3). */
  TEAM: 'TEAM',
  REPOSITORY: 'REPOSITORY',
  COMMIT: 'COMMIT',
  PULL_REQUEST: 'PULL_REQUEST',
  REVIEW: 'REVIEW',
  JIRA_ISSUE: 'JIRA_ISSUE',
  /** Reserved for feature discovery (ANALYTICS.md §6); nothing populates it yet. */
  FEATURE: 'FEATURE',
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

export const EdgeType = {
  /** DEVELOPER → TEAM. Reserved: no source data. */
  MEMBER_OF: 'MEMBER_OF',
  /** TEAM → REPOSITORY. Reserved: no source data. */
  OWNS: 'OWNS',
  /** DEVELOPER → REPOSITORY. Derived: exists while ≥1 commit, PR or review does. */
  CONTRIBUTED_TO: 'CONTRIBUTED_TO',
  /** DEVELOPER → COMMIT | PULL_REQUEST | REVIEW. */
  CREATED: 'CREATED',
  /** COMMIT | PULL_REQUEST → REPOSITORY; REVIEW → PULL_REQUEST. */
  BELONGS_TO: 'BELONGS_TO',
  /** DEVELOPER → PULL_REQUEST. Derived from that developer's REVIEW nodes. */
  REVIEWED: 'REVIEWED',
  /** PULL_REQUEST → JIRA_ISSUE, from a `pr_implements_story` correlation link. */
  REFERENCES: 'REFERENCES',
  /** JIRA_ISSUE → DEVELOPER, through the Jira assignee identity bridge. */
  ASSIGNED_TO: 'ASSIGNED_TO',
  /** FEATURE → REPOSITORY. Reserved. */
  IMPLEMENTED_IN: 'IMPLEMENTED_IN',
  /** FEATURE → JIRA_ISSUE. Reserved. */
  RELATES_TO: 'RELATES_TO',
} as const;
export type EdgeType = (typeof EdgeType)[keyof typeof EdgeType];

export interface DeveloperNode {
  type: typeof NodeType.DEVELOPER;
  developerId: string;
  displayName: string;
  isBot: boolean;
  isAnonymized: boolean;
  /** Admin-excluded identity (`DeveloperIdentity.excluded`). */
  excluded: boolean;
}

export interface TeamNode {
  type: typeof NodeType.TEAM;
  name: string;
}

export interface RepositoryNode {
  type: typeof NodeType.REPOSITORY;
  fullName: string;
  url: string;
}

export interface CommitNode {
  type: typeof NodeType.COMMIT;
  id: string;
  repoFullName: string;
  sha: string;
  authoredAt: string;
  /** `parentCount > 1`; null when the collector never recorded parents. */
  isMerge: boolean | null;
}

export interface PullRequestNode {
  type: typeof NodeType.PULL_REQUEST;
  id: string;
  repoFullName: string;
  number: string;
  title: string;
  state: string;
  openedAt: string | null;
  mergedAt: string | null;
}

export interface ReviewNode {
  type: typeof NodeType.REVIEW;
  id: string;
  repoFullName: string;
  prNumber: string;
  state: string;
  submittedAt: string;
  isBot: boolean;
}

export interface JiraIssueNode {
  type: typeof NodeType.JIRA_ISSUE;
  id: string;
  key: string;
  title: string;
  status: string;
  issueType: string;
}

export interface FeatureNode {
  type: typeof NodeType.FEATURE;
  name: string;
  keywords: string[];
}

export type GraphNode =
  | DeveloperNode
  | TeamNode
  | RepositoryNode
  | CommitNode
  | PullRequestNode
  | ReviewNode
  | JiraIssueNode
  | FeatureNode;

export interface GraphEdge {
  type: EdgeType;
  /** REFERENCES: the correlation link's confidence score. */
  confidence?: number;
  /** How a correlation edge was made (`regex`, …). */
  method?: string;
  /** REVIEWED: reviews this developer submitted on the PR. */
  count?: number;
  /** CONTRIBUTED_TO / REVIEWED: the latest underlying activity. */
  lastAt?: string;
}

export function nodeKey(type: NodeType, id: string): string {
  return `${type}:${id}`;
}

/**
 * Repository node id. Repos have no table (DATA-MODEL.md §3): `repoFullName`
 * is the identity every fact row carries, lower-cased because GitHub treats
 * `Org/Repo` and `org/repo` as one repository.
 */
export function repositoryId(fullName: string): string {
  return fullName.trim().toLowerCase();
}

export function repositoryKey(fullName: string): string {
  return nodeKey(NodeType.REPOSITORY, repositoryId(fullName));
}

export function developerKey(developerId: string): string {
  return nodeKey(NodeType.DEVELOPER, developerId);
}

export function edgeKey(
  type: EdgeType,
  source: string,
  target: string,
): string {
  return `${type}|${source}|${target}`;
}

/** A developer as the source rows resolve them (see `DeveloperDirectory`). */
export interface DeveloperRef {
  developerId: string;
  displayName: string;
  excluded: boolean;
}

export interface CommitRecord {
  id: string;
  repoFullName: string;
  sha: string;
  authoredAt: Date;
  parentCount: number | null;
  author?: DeveloperRef;
}

export interface ReviewRecord {
  id: string;
  repoFullName: string;
  prNumber: string;
  state: string;
  submittedAt: Date;
  isBot: boolean;
  reviewer?: DeveloperRef;
}

export interface IssueRecord {
  id: string;
  key: string;
  title: string;
  status: string;
  type: string;
  assignee?: DeveloperRef;
}

export interface IssueLinkRecord {
  issue: IssueRecord;
  confidence: number;
  method: string;
}

export interface PullRequestRecord {
  id: string;
  repoFullName: string;
  number: string;
  title: string;
  state: string;
  openedAt: Date | null;
  mergedAt: Date | null;
  author?: DeveloperRef;
  /** The PR's full review set as stored — replaces what the graph held. */
  reviews: ReviewRecord[];
  /** Its `pr_implements_story` links — replaces what the graph held. */
  issueLinks: IssueLinkRecord[];
}

/** Everything one tenant's graph is built from. */
export interface GraphSnapshot {
  commits: CommitRecord[];
  pullRequests: PullRequestRecord[];
  /** Issues reached by assignment rather than through a PR link. */
  issues: IssueRecord[];
}

/** One changed source row, by natural key — the updater's whole input. */
export type GraphChange =
  | { entity: 'commit'; repoFullName: string; sha: string }
  | { entity: 'pull_request'; repoFullName: string; externalNumber: string }
  | { entity: 'issue'; externalKey: string };

export function changeKey(change: GraphChange): string {
  switch (change.entity) {
    case 'commit':
      return `commit|${repositoryId(change.repoFullName)}@${change.sha}`;
    case 'pull_request':
      return `pull_request|${repositoryId(change.repoFullName)}#${change.externalNumber}`;
    case 'issue':
      return `issue|${change.externalKey}`;
  }
}
