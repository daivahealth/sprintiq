import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  CommitNode,
  DeveloperNode,
  developerKey,
  EdgeType,
  GraphNode,
  JiraIssueNode,
  NodeType,
  PullRequestNode,
  RepositoryNode,
  repositoryId,
  repositoryKey,
  ReviewNode,
} from './knowledge-graph.types';
import { activityAt, TenantGraph } from './tenant-graph';

/**
 * The rule these reads are computed under (ADR-0013). Shipped in every
 * response that names people, as the decision requires.
 */
export const KNOWLEDGE_GRAPH_RULE =
  'Admin-only (ADR-0013). Counts show where work happened in the loaded ' +
  'window, not how well anyone works: people are listed alphabetically and ' +
  'never ranked. Bots, anonymized accounts and admin-excluded identities are ' +
  'withheld from names but stay in totals. Work whose author resolves to no ' +
  'known developer is reported as unattributed, never assigned to anyone.';

export interface RepositoryRef {
  id: string;
  fullName: string;
  url: string;
}

export interface PersonRef {
  developerId: string;
  displayName: string;
}

/** Whose work an item is, without ever naming a withheld identity. */
export type Attribution =
  | { attribution: 'person'; author: PersonRef }
  | { attribution: 'withheld'; author: null }
  | { attribution: 'unattributed'; author: null };

export interface RepositorySummary extends RepositoryRef {
  commitCount: number;
  pullRequestCount: number;
}

export interface RepositoryDeveloper extends PersonRef {
  commitCount: number;
  pullRequestCount: number;
  reviewCount: number;
  lastContributionAt: string | null;
}

export interface WorkCounts {
  commits: number;
  pullRequests: number;
  reviews: number;
}

export interface RepositoryDevelopersView {
  repository: RepositoryRef;
  /** Alphabetical by `displayName`; the ordering is part of the contract. */
  developers: RepositoryDeveloper[];
  totals: WorkCounts;
  /** Work with no resolvable author — counted, never hidden. */
  unattributed: WorkCounts;
  /** Bots, anonymized and admin-excluded identities: in totals, never named. */
  withheld: WorkCounts & { identities: number };
}

export interface DeveloperRepository extends RepositoryRef {
  commitCount: number;
  pullRequestsCreated: number;
  pullRequestsReviewed: number;
  reviewCount: number;
  lastContributionAt: string | null;
  recentCommits: { sha: string; authoredAt: string }[];
  /** Issues linked to PRs this developer created or reviewed here. */
  jiraIssues: IssueRef[];
}

export interface IssueRef {
  key: string;
  title: string;
  status: string;
  type: string;
}

export interface DeveloperRepositoriesView {
  developer: PersonRef;
  /** Alphabetical by `fullName`. */
  repositories: DeveloperRepository[];
  /** Issues assigned to this developer through the Jira identity bridge. */
  assignedIssues: IssueRef[];
}

export interface RepositoryActivitiesView {
  repository: RepositoryRef;
  commits: Page<
    { sha: string; authoredAt: string; isMerge: boolean | null } & Attribution
  >;
  pullRequests: Page<
    {
      number: string;
      title: string;
      state: string;
      openedAt: string | null;
      mergedAt: string | null;
      jiraKeys: string[];
    } & Attribution
  >;
  reviews: Page<
    { prNumber: string; state: string; submittedAt: string } & Attribution
  >;
  jiraIssues: Page<
    IssueRef & {
      pullRequests: { number: string; confidence?: number; method?: string }[];
    }
  >;
}

export interface Page<T> {
  total: number;
  /** Newest first (issues: by key), capped at the request's `limit`. */
  items: T[];
}

/** Repos whose name or URL contains `q`, alphabetical. */
export function searchRepositories(
  g: TenantGraph,
  q: string,
  limit: number,
): RepositorySummary[] {
  const needle = q.trim().toLowerCase();
  if (!needle) {
    throw new BadRequestException('q is required.');
  }
  const out: RepositorySummary[] = [];
  g.graph.forEachNode((key, attrs) => {
    if (attrs.type !== NodeType.REPOSITORY) {
      return;
    }
    if (
      !attrs.fullName.toLowerCase().includes(needle) &&
      !attrs.url.toLowerCase().includes(needle)
    ) {
      return;
    }
    let commitCount = 0;
    let pullRequestCount = 0;
    forEachInSource(g, key, EdgeType.BELONGS_TO, (_k, source) => {
      if (source.type === NodeType.COMMIT) {
        commitCount++;
      } else if (source.type === NodeType.PULL_REQUEST) {
        pullRequestCount++;
      }
    });
    out.push({ ...repositoryRef(attrs), commitCount, pullRequestCount });
  });
  return out
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .slice(0, limit);
}

/**
 * Resolves a repository by its id (`owner/name`, any case), its URL, or a
 * bare name when exactly one loaded repo carries it.
 */
export function resolveRepository(g: TenantGraph, input: string): string {
  const normalized = repositoryId(
    input
      .trim()
      .replace(/^[a-z]+:\/\/[^/]+\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, ''),
  );
  if (!normalized) {
    throw new BadRequestException('A repository id, name or URL is required.');
  }
  const direct = repositoryKey(normalized);
  if (g.graph.hasNode(direct)) {
    return direct;
  }
  if (!normalized.includes('/')) {
    const candidates: string[] = [];
    g.graph.forEachNode((key, attrs) => {
      if (
        attrs.type === NodeType.REPOSITORY &&
        repositoryId(attrs.fullName).split('/').pop() === normalized
      ) {
        candidates.push(attrs.fullName);
      }
    });
    if (candidates.length === 1) {
      return repositoryKey(candidates[0]);
    }
    if (candidates.length > 1) {
      // In the message itself: the global exception filter keeps only that.
      throw new ConflictException(
        `"${input}" matches more than one repository (${candidates
          .sort()
          .join(', ')}); use owner/name.`,
      );
    }
  }
  throw new NotFoundException(
    `No repository "${input}" has activity in the loaded window.`,
  );
}

export function repositoryDevelopers(
  g: TenantGraph,
  repoKey: string,
): RepositoryDevelopersView {
  const repo = g.graph.getNodeAttributes(repoKey) as RepositoryNode;
  const people = new Map<string, RepositoryDeveloper>();
  const totals: WorkCounts = { commits: 0, pullRequests: 0, reviews: 0 };
  const unattributed: WorkCounts = { commits: 0, pullRequests: 0, reviews: 0 };
  const withheld = { commits: 0, pullRequests: 0, reviews: 0, identities: 0 };
  const withheldIds = new Set<string>();

  const credit = (
    itemKey: string,
    item: GraphNode,
    bucket: keyof WorkCounts,
  ): void => {
    totals[bucket]++;
    const creator = creatorOf(g, itemKey);
    if (!creator) {
      unattributed[bucket]++;
      return;
    }
    if (isWithheld(creator)) {
      withheld[bucket]++;
      withheldIds.add(creator.developerId);
      return;
    }
    const row = people.get(creator.developerId) ?? {
      developerId: creator.developerId,
      displayName: creator.displayName,
      commitCount: 0,
      pullRequestCount: 0,
      reviewCount: 0,
      lastContributionAt: null,
    };
    if (bucket === 'commits') {
      row.commitCount++;
    } else if (bucket === 'pullRequests') {
      row.pullRequestCount++;
    } else {
      row.reviewCount++;
    }
    row.lastContributionAt = latest(row.lastContributionAt, activityAt(item));
    people.set(creator.developerId, row);
  };

  forEachInSource(g, repoKey, EdgeType.BELONGS_TO, (itemKey, item) => {
    if (item.type === NodeType.COMMIT) {
      credit(itemKey, item, 'commits');
    } else if (item.type === NodeType.PULL_REQUEST) {
      credit(itemKey, item, 'pullRequests');
      forEachInSource(g, itemKey, EdgeType.BELONGS_TO, (reviewKey, review) => {
        if (review.type === NodeType.REVIEW) {
          credit(reviewKey, review, 'reviews');
        }
      });
    }
  });
  withheld.identities = withheldIds.size;

  return {
    repository: repositoryRef(repo),
    developers: [...people.values()].sort(byDisplayName),
    totals,
    unattributed,
    withheld,
  };
}

export function developerRepositories(
  g: TenantGraph,
  developerId: string,
  recentLimit: number,
): DeveloperRepositoriesView {
  const devKey = developerKey(developerId);
  if (!g.graph.hasNode(devKey)) {
    throw new NotFoundException(
      `Developer "${developerId}" has no activity in the loaded window.`,
    );
  }
  const developer = g.graph.getNodeAttributes(devKey) as DeveloperNode;
  if (isWithheld(developer)) {
    // Suppressions are honoured before anyone is named (ADR-0013 §2).
    throw new NotFoundException(
      `Developer "${developerId}" is withheld (automation, anonymized or admin-excluded).`,
    );
  }

  const rows = new Map<string, DeveloperRepository>();
  const issuesByRepo = new Map<string, Map<string, IssueRef>>();
  const rowFor = (repoKey: string): DeveloperRepository => {
    let row = rows.get(repoKey);
    if (!row) {
      const repo = g.graph.getNodeAttributes(repoKey) as RepositoryNode;
      row = {
        ...repositoryRef(repo),
        commitCount: 0,
        pullRequestsCreated: 0,
        pullRequestsReviewed: 0,
        reviewCount: 0,
        lastContributionAt: null,
        recentCommits: [],
        jiraIssues: [],
      };
      rows.set(repoKey, row);
      issuesByRepo.set(repoKey, new Map());
    }
    return row;
  };
  const collectIssues = (repoKey: string, prKey: string): void => {
    const issues = issuesByRepo.get(repoKey);
    g.graph.forEachOutEdge(prKey, (_e, attrs, _s, _t, _sa, target) => {
      if (
        attrs.type === EdgeType.REFERENCES &&
        target.type === NodeType.JIRA_ISSUE
      ) {
        issues?.set(target.key, issueRef(target));
      }
    });
  };

  const commitsByRepo = new Map<string, CommitNode[]>();
  g.graph.forEachOutEdge(devKey, (_e, attrs, _s, target, _sa, item) => {
    if (attrs.type === EdgeType.CONTRIBUTED_TO) {
      rowFor(target);
      return;
    }
    if (
      attrs.type === EdgeType.REVIEWED &&
      item.type === NodeType.PULL_REQUEST
    ) {
      const repoKey = repositoryKey(item.repoFullName);
      rowFor(repoKey).pullRequestsReviewed++;
      collectIssues(repoKey, target);
      return;
    }
    if (attrs.type !== EdgeType.CREATED) {
      return;
    }
    if (item.type === NodeType.COMMIT) {
      const repoKey = repositoryKey(item.repoFullName);
      const row = rowFor(repoKey);
      row.commitCount++;
      row.lastContributionAt = latest(row.lastContributionAt, activityAt(item));
      const commits = commitsByRepo.get(repoKey) ?? [];
      commits.push(item);
      commitsByRepo.set(repoKey, commits);
    } else if (item.type === NodeType.PULL_REQUEST) {
      const repoKey = repositoryKey(item.repoFullName);
      const row = rowFor(repoKey);
      row.pullRequestsCreated++;
      row.lastContributionAt = latest(row.lastContributionAt, activityAt(item));
      collectIssues(repoKey, target);
    } else if (item.type === NodeType.REVIEW) {
      const row = rowFor(repositoryKey(item.repoFullName));
      row.reviewCount++;
      row.lastContributionAt = latest(row.lastContributionAt, activityAt(item));
    }
  });

  for (const [repoKey, row] of rows) {
    row.recentCommits = (commitsByRepo.get(repoKey) ?? [])
      .sort((a, b) => b.authoredAt.localeCompare(a.authoredAt))
      .slice(0, recentLimit)
      .map((c) => ({ sha: c.sha, authoredAt: c.authoredAt }));
    row.jiraIssues = [...(issuesByRepo.get(repoKey)?.values() ?? [])].sort(
      (a, b) => a.key.localeCompare(b.key),
    );
  }

  const assignedIssues: IssueRef[] = [];
  forEachInSource(g, devKey, EdgeType.ASSIGNED_TO, (_k, issue) => {
    if (issue.type === NodeType.JIRA_ISSUE) {
      assignedIssues.push(issueRef(issue));
    }
  });

  return {
    developer: {
      developerId: developer.developerId,
      displayName: developer.displayName,
    },
    repositories: [...rows.values()].sort((a, b) =>
      a.fullName.localeCompare(b.fullName),
    ),
    assignedIssues: assignedIssues.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function repositoryActivities(
  g: TenantGraph,
  repoKey: string,
  limit: number,
): RepositoryActivitiesView {
  const repo = g.graph.getNodeAttributes(repoKey) as RepositoryNode;
  const commits: RepositoryActivitiesView['commits']['items'] = [];
  const pullRequests: RepositoryActivitiesView['pullRequests']['items'] = [];
  const reviews: RepositoryActivitiesView['reviews']['items'] = [];
  const issues = new Map<
    string,
    RepositoryActivitiesView['jiraIssues']['items'][number]
  >();

  forEachInSource(g, repoKey, EdgeType.BELONGS_TO, (itemKey, item) => {
    if (item.type === NodeType.COMMIT) {
      commits.push({
        sha: item.sha,
        authoredAt: item.authoredAt,
        isMerge: item.isMerge,
        ...attribution(creatorOf(g, itemKey)),
      });
      return;
    }
    if (item.type !== NodeType.PULL_REQUEST) {
      return;
    }
    const pr: PullRequestNode = item;
    const jiraKeys: string[] = [];
    g.graph.forEachOutEdge(itemKey, (_e, attrs, _s, _t, _sa, target) => {
      if (
        attrs.type !== EdgeType.REFERENCES ||
        target.type !== NodeType.JIRA_ISSUE
      ) {
        return;
      }
      jiraKeys.push(target.key);
      const entry = issues.get(target.key) ?? {
        ...issueRef(target),
        pullRequests: [],
      };
      entry.pullRequests.push({
        number: pr.number,
        confidence: attrs.confidence,
        method: attrs.method,
      });
      issues.set(target.key, entry);
    });
    pullRequests.push({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      openedAt: pr.openedAt,
      mergedAt: pr.mergedAt,
      jiraKeys: jiraKeys.sort(),
      ...attribution(creatorOf(g, itemKey)),
    });
    forEachInSource(g, itemKey, EdgeType.BELONGS_TO, (reviewKey, review) => {
      if (review.type === NodeType.REVIEW) {
        const r: ReviewNode = review;
        reviews.push({
          prNumber: r.prNumber,
          state: r.state,
          submittedAt: r.submittedAt,
          ...attribution(creatorOf(g, reviewKey)),
        });
      }
    });
  });

  return {
    repository: repositoryRef(repo),
    commits: page(commits, limit, (c) => c.authoredAt),
    pullRequests: page(
      pullRequests,
      limit,
      (p) => p.mergedAt ?? p.openedAt ?? '',
    ),
    reviews: page(reviews, limit, (r) => r.submittedAt),
    jiraIssues: {
      total: issues.size,
      items: [...issues.values()]
        .sort((a, b) => a.key.localeCompare(b.key))
        .slice(0, limit),
    },
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Bots, anonymized accounts and admin exclusions are never named. */
export function isWithheld(developer: DeveloperNode): boolean {
  return developer.isBot || developer.isAnonymized || developer.excluded;
}

function creatorOf(g: TenantGraph, key: string): DeveloperNode | undefined {
  let creator: DeveloperNode | undefined;
  forEachInSource(g, key, EdgeType.CREATED, (_k, source) => {
    if (source.type === NodeType.DEVELOPER) {
      creator = source;
    }
  });
  return creator;
}

function attribution(creator: DeveloperNode | undefined): Attribution {
  if (!creator) {
    return { attribution: 'unattributed', author: null };
  }
  if (isWithheld(creator)) {
    return { attribution: 'withheld', author: null };
  }
  return {
    attribution: 'person',
    author: {
      developerId: creator.developerId,
      displayName: creator.displayName,
    },
  };
}

function forEachInSource(
  g: TenantGraph,
  key: string,
  type: EdgeType,
  fn: (sourceKey: string, source: GraphNode) => void,
): void {
  g.graph.forEachInEdge(key, (_e, attrs, source, _t, sourceAttrs) => {
    if (attrs.type === type) {
      fn(source, sourceAttrs);
    }
  });
}

function repositoryRef(repo: RepositoryNode): RepositoryRef {
  return {
    id: repositoryId(repo.fullName),
    fullName: repo.fullName,
    url: repo.url,
  };
}

function issueRef(issue: JiraIssueNode): IssueRef {
  return {
    key: issue.key,
    title: issue.title,
    status: issue.status,
    type: issue.issueType,
  };
}

function page<T>(items: T[], limit: number, at: (item: T) => string): Page<T> {
  return {
    total: items.length,
    items: items.sort((a, b) => at(b).localeCompare(at(a))).slice(0, limit),
  };
}

function byDisplayName(a: PersonRef, b: PersonRef): number {
  return (
    a.displayName.localeCompare(b.displayName) ||
    a.developerId.localeCompare(b.developerId)
  );
}

function latest(a: string | null, b: string | undefined): string | null {
  if (!b) {
    return a;
  }
  return !a || b > a ? b : a;
}
