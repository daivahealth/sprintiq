import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api/client';

/**
 * KnowledgeGraphService — the explorer's only door to the backend.
 *
 * Types mirror the BC-10 contracts exactly (docs/api/README.md §9,
 * `backend/src/analytics/knowledge-graph/graph-queries.ts`). Nothing here
 * resolves identities, joins records or derives relationships: every node and
 * edge the explorer draws comes from one of these five responses.
 */

export type GraphPhase = 'disabled' | 'initializing' | 'ready' | 'failed';
export type TenantGraphState = 'building' | 'ready' | 'failed' | 'not_loaded';

export interface KgFreshness {
  builtAt: string;
  windowStart: string;
  windowDays: number;
  lastIncrementalAt: string | null;
  stale: boolean;
  rebuildMinutes: number;
}

export interface KgStatus {
  status: GraphPhase;
  enabled: boolean;
  windowDays: number;
  rebuildMinutes: number;
  tenant: {
    state: TenantGraphState;
    builtAt: string | null;
    windowStart: string | null;
    lastIncrementalAt: string | null;
    stale: boolean;
    error: string | null;
    totalNodes: number;
    totalEdges: number;
    nodesByType: Record<string, number> | null;
    edgesByType: Record<string, number> | null;
  };
}

export interface RepositoryRef {
  /** Lower-cased `owner/name` — what every repository route takes as `:id`. */
  id: string;
  fullName: string;
  url: string;
}

export interface RepositorySummary extends RepositoryRef {
  commitCount: number;
  pullRequestCount: number;
}

export interface PersonRef {
  developerId: string;
  displayName: string;
}

export interface WorkCounts {
  commits: number;
  pullRequests: number;
  reviews: number;
}

export interface RepositoryDeveloper extends PersonRef {
  commitCount: number;
  pullRequestCount: number;
  reviewCount: number;
  lastContributionAt: string | null;
}

export interface RepositoryDevelopersResponse {
  repository: RepositoryRef;
  /** Alphabetical by displayName — the ordering is part of the contract. */
  developers: RepositoryDeveloper[];
  totals: WorkCounts;
  unattributed: WorkCounts;
  withheld: WorkCounts & { identities: number };
  rule: string;
  freshness: KgFreshness;
}

export interface IssueRef {
  key: string;
  title: string;
  status: string;
  type: string;
}

export interface DeveloperRepository extends RepositoryRef {
  commitCount: number;
  pullRequestsCreated: number;
  pullRequestsReviewed: number;
  reviewCount: number;
  lastContributionAt: string | null;
  recentCommits: { sha: string; authoredAt: string }[];
  jiraIssues: IssueRef[];
}

export interface DeveloperRepositoriesResponse {
  developer: PersonRef;
  repositories: DeveloperRepository[];
  assignedIssues: IssueRef[];
  rule: string;
  freshness: KgFreshness;
}

export type Attribution =
  | { attribution: 'person'; author: PersonRef }
  | { attribution: 'withheld'; author: null }
  | { attribution: 'unattributed'; author: null };

export interface Page<T> {
  total: number;
  items: T[];
}

export type ActivityCommit = {
  sha: string;
  authoredAt: string;
  isMerge: boolean | null;
} & Attribution;

export type ActivityPullRequest = {
  number: string;
  title: string;
  state: string;
  openedAt: string | null;
  mergedAt: string | null;
  jiraKeys: string[];
} & Attribution;

export type ActivityReview = {
  prNumber: string;
  state: string;
  submittedAt: string;
} & Attribution;

export interface ActivityIssue extends IssueRef {
  pullRequests: { number: string; confidence?: number; method?: string }[];
}

export interface RepositoryActivitiesResponse {
  repository: RepositoryRef;
  commits: Page<ActivityCommit>;
  pullRequests: Page<ActivityPullRequest>;
  reviews: Page<ActivityReview>;
  jiraIssues: Page<ActivityIssue>;
  rule: string;
  freshness: KgFreshness;
}

/** Newest items per activity list; the API caps `limit` at 200. */
export const ACTIVITY_LIMIT = 100;
export const SEARCH_LIMIT = 25;

const BASE = '/api/knowledge-graph';

export const knowledgeGraphService = {
  status: () => api.get<KgStatus>(`${BASE}/status`),
  searchRepositories: (q: string, limit = SEARCH_LIMIT) =>
    api.get<{ items: RepositorySummary[]; count: number; freshness: KgFreshness }>(
      `${BASE}/repositories/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  repositoryDevelopers: (repoId: string) =>
    api.get<RepositoryDevelopersResponse>(
      `${BASE}/repositories/${encodeURIComponent(repoId)}/developers`,
    ),
  repositoryActivities: (repoId: string, limit = ACTIVITY_LIMIT) =>
    api.get<RepositoryActivitiesResponse>(
      `${BASE}/repositories/${encodeURIComponent(repoId)}/activities?limit=${limit}`,
    ),
  developerRepositories: (developerId: string, limit = 5) =>
    api.get<DeveloperRepositoriesResponse>(
      `${BASE}/developers/${encodeURIComponent(developerId)}/repositories?limit=${limit}`,
    ),
};

/**
 * Client errors are answers, not blips: a 403, 404 or 409 retried is the same
 * answer three times. A 503 is the graph still building, which the status
 * poll — not a retry loop — waits out.
 */
function retryTransient(failures: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 600) {
    return false;
  }
  return failures < 1;
}

export function useGraphStatus() {
  return useQuery({
    queryKey: ['knowledge-graph', 'status'],
    queryFn: knowledgeGraphService.status,
    retry: retryTransient,
    // Poll quickly while a build is under way, slowly once it is ready.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || query.state.error) {
        return 30_000;
      }
      return data.status === 'ready' && data.tenant.state === 'ready'
        ? 60_000
        : 5_000;
    },
  });
}

export function useRepositorySearch(q: string, enabled: boolean) {
  const term = q.trim();
  return useQuery({
    queryKey: ['knowledge-graph', 'search', term],
    queryFn: () => knowledgeGraphService.searchRepositories(term),
    // The API rejects an empty query; the dropdown asks for a term instead.
    enabled: enabled && term.length > 0,
    retry: retryTransient,
    placeholderData: keepPreviousData,
  });
}

export function useRepositoryDevelopers(repoId: string | null) {
  return useQuery({
    queryKey: ['knowledge-graph', 'repository', repoId, 'developers'],
    queryFn: () => knowledgeGraphService.repositoryDevelopers(repoId ?? ''),
    enabled: Boolean(repoId),
    retry: retryTransient,
  });
}

/**
 * Activities are fetched only once something needs them (an expansion or the
 * activity tabs): every call is an audited named-person read on the server.
 */
export function useRepositoryActivities(repoId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['knowledge-graph', 'repository', repoId, 'activities', ACTIVITY_LIMIT],
    queryFn: () => knowledgeGraphService.repositoryActivities(repoId ?? ''),
    enabled: enabled && Boolean(repoId),
    retry: retryTransient,
  });
}

export function useDeveloperRepositories(developerId: string | null) {
  return useQuery({
    queryKey: ['knowledge-graph', 'developer', developerId, 'repositories'],
    queryFn: () => knowledgeGraphService.developerRepositories(developerId ?? ''),
    enabled: Boolean(developerId),
    retry: retryTransient,
  });
}
