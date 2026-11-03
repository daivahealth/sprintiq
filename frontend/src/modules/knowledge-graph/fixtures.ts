import type {
  DeveloperRepositoriesResponse,
  KgFreshness,
  KgStatus,
  RepositoryActivitiesResponse,
  RepositoryDevelopersResponse,
} from './api';

/**
 * Response fixtures shaped exactly like the backend contracts, for tests
 * only. Names are illustrative.
 */

export const freshness: KgFreshness = {
  builtAt: '2026-11-03T05:00:00.000Z',
  windowStart: '2026-08-05T05:00:00.000Z',
  windowDays: 90,
  lastIncrementalAt: null,
  stale: false,
  rebuildMinutes: 30,
};

export const RULE =
  'Admin-only (ADR-0013). Counts show where work happened in the loaded window, not how well anyone works.';

export const repository = {
  id: 'acme/invoice-service',
  fullName: 'acme/invoice-service',
  url: 'https://github.com/acme/invoice-service',
};

export function developersResponse(
  over: Partial<RepositoryDevelopersResponse> = {},
): RepositoryDevelopersResponse {
  return {
    repository,
    developers: [
      {
        developerId: 'asha',
        displayName: 'Asha Rao',
        commitCount: 2,
        pullRequestCount: 1,
        reviewCount: 0,
        lastContributionAt: '2026-10-31T09:00:00.000Z',
      },
      {
        developerId: 'dev',
        displayName: 'Dev Kumar',
        commitCount: 9,
        pullRequestCount: 0,
        reviewCount: 1,
        lastContributionAt: '2026-10-29T09:00:00.000Z',
      },
    ],
    totals: { commits: 13, pullRequests: 1, reviews: 2 },
    unattributed: { commits: 1, pullRequests: 0, reviews: 0 },
    withheld: { commits: 1, pullRequests: 0, reviews: 1, identities: 1 },
    rule: RULE,
    freshness,
    ...over,
  };
}

export function activitiesResponse(
  over: Partial<RepositoryActivitiesResponse> = {},
): RepositoryActivitiesResponse {
  return {
    repository,
    commits: {
      total: 4,
      items: [
        {
          sha: 'aaaaaaa1111',
          authoredAt: '2026-10-31T09:00:00.000Z',
          isMerge: false,
          attribution: 'person',
          author: { developerId: 'asha', displayName: 'Asha Rao' },
        },
        {
          sha: 'bbbbbbb2222',
          authoredAt: '2026-10-30T09:00:00.000Z',
          isMerge: false,
          attribution: 'person',
          author: { developerId: 'dev', displayName: 'Dev Kumar' },
        },
        {
          sha: 'ccccccc3333',
          authoredAt: '2026-10-29T09:00:00.000Z',
          isMerge: false,
          attribution: 'withheld',
          author: null,
        },
        {
          sha: 'ddddddd4444',
          authoredAt: '2026-10-28T09:00:00.000Z',
          isMerge: null,
          attribution: 'unattributed',
          author: null,
        },
      ],
    },
    pullRequests: {
      total: 1,
      items: [
        {
          number: '312',
          title: 'BILL-482 credit-note invoices',
          state: 'merged',
          openedAt: '2026-10-28T10:00:00.000Z',
          mergedAt: '2026-10-30T12:00:00.000Z',
          jiraKeys: ['BILL-482'],
          attribution: 'person',
          author: { developerId: 'asha', displayName: 'Asha Rao' },
        },
      ],
    },
    reviews: {
      total: 3,
      items: [
        {
          prNumber: '312',
          state: 'approved',
          submittedAt: '2026-10-30T11:00:00.000Z',
          attribution: 'person',
          author: { developerId: 'dev', displayName: 'Dev Kumar' },
        },
        {
          prNumber: '312',
          state: 'commented',
          submittedAt: '2026-10-30T10:00:00.000Z',
          attribution: 'withheld',
          author: null,
        },
        {
          // A PR outside the loaded page, named only by the review.
          prNumber: '298',
          state: 'approved',
          submittedAt: '2026-10-20T10:00:00.000Z',
          attribution: 'person',
          author: { developerId: 'dev', displayName: 'Dev Kumar' },
        },
      ],
    },
    jiraIssues: {
      total: 1,
      items: [
        {
          key: 'BILL-482',
          title: 'Invoice generation for credit notes',
          status: 'Done',
          type: 'story',
          pullRequests: [{ number: '312', confidence: 0.8, method: 'regex' }],
        },
      ],
    },
    rule: RULE,
    freshness,
    ...over,
  };
}

export function developerReposResponse(
  over: Partial<DeveloperRepositoriesResponse> = {},
): DeveloperRepositoriesResponse {
  return {
    developer: { developerId: 'asha', displayName: 'Asha Rao' },
    repositories: [
      {
        ...repository,
        commitCount: 2,
        pullRequestsCreated: 1,
        pullRequestsReviewed: 0,
        reviewCount: 0,
        lastContributionAt: '2026-10-31T09:00:00.000Z',
        recentCommits: [{ sha: 'aaaaaaa1111', authoredAt: '2026-10-31T09:00:00.000Z' }],
        jiraIssues: [
          { key: 'BILL-482', title: 'Invoice generation for credit notes', status: 'Done', type: 'story' },
        ],
      },
      {
        id: 'acme/ledger',
        fullName: 'acme/ledger',
        url: 'https://github.com/acme/ledger',
        commitCount: 5,
        pullRequestsCreated: 0,
        pullRequestsReviewed: 2,
        reviewCount: 2,
        lastContributionAt: '2026-10-20T09:00:00.000Z',
        recentCommits: [],
        jiraIssues: [],
      },
    ],
    assignedIssues: [
      { key: 'BILL-501', title: 'Invoice PDF footer', status: 'In Progress', type: 'task' },
    ],
    rule: RULE,
    freshness,
    ...over,
  };
}

export function statusResponse(over: Partial<KgStatus['tenant']> = {}, status: KgStatus['status'] = 'ready'): KgStatus {
  return {
    status,
    enabled: status !== 'disabled',
    windowDays: 90,
    rebuildMinutes: 30,
    tenant: {
      state: 'ready',
      builtAt: '2026-11-03T05:00:00.000Z',
      windowStart: '2026-08-05T05:00:00.000Z',
      lastIncrementalAt: null,
      stale: false,
      error: null,
      totalNodes: 41188,
      totalEdges: 83066,
      nodesByType: { DEVELOPER: 103, TEAM: 0, REPOSITORY: 161, COMMIT: 15993, PULL_REQUEST: 6321, REVIEW: 6718, JIRA_ISSUE: 11892, FEATURE: 0 },
      edgesByType: { MEMBER_OF: 0, OWNS: 0, CONTRIBUTED_TO: 1017, CREATED: 29032, BELONGS_TO: 29032, REVIEWED: 6546, REFERENCES: 5775, ASSIGNED_TO: 11664, IMPLEMENTED_IN: 0, RELATES_TO: 0 },
      ...over,
    },
  };
}
