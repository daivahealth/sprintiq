import type {
  KgStatus,
  RepositoryActivitiesResponse,
  RepositoryDevelopersResponse,
} from './api';
import type { EntityType } from './entity-registry';

/**
 * Relationship Coverage: which relationships the explorer can show, and why
 * any it cannot are missing.
 *
 * Four different absences are kept apart on purpose, because they mean
 * different things to an administrator:
 *  - **not implemented** — the backend has no source for it (no edge exists
 *    anywhere, by construction);
 *  - **no matching data** — implemented, but nothing in this scope;
 *  - **partial** — implemented, but some records cannot be attributed;
 *  - **inferred** (`basis`) — present, but made by correlation with a
 *    confidence score rather than recorded by a source system.
 *
 * Capabilities are the backend's documented model (features/ANALYTICS.md §2–3);
 * the status of each row comes from the numbers the API returned, never from
 * an assumption that a relationship is populated.
 */

export type CoverageStatus =
  | 'available'
  | 'partial'
  | 'not_implemented'
  | 'no_data'
  | 'planned';

export type CoverageBasis = 'recorded' | 'derived' | 'inferred' | 'none';

export interface CoverageRow {
  id: string;
  from: EntityType;
  to: EntityType;
  basis: CoverageBasis;
  status: CoverageStatus;
  explanation: string;
}

export const COVERAGE_STATUS_LABEL: Record<CoverageStatus, string> = {
  available: 'Available',
  partial: 'Partially available',
  not_implemented: 'Not implemented',
  no_data: 'No matching data found',
  planned: 'Planned',
};

export interface CoverageInput {
  status?: KgStatus;
  /** The selected repository's developers response, when one is selected. */
  repository?: RepositoryDevelopersResponse;
  /** Its activities, once loaded. */
  activities?: RepositoryActivitiesResponse;
}

type Noun = 'commits' | 'pull requests' | 'reviews';

export function relationshipCoverage(input: CoverageInput): CoverageRow[] {
  const repo = input.repository;
  const edges = input.status?.tenant.edgesByType ?? {};
  const tenantCount = (type: string) => edges[type] ?? 0;

  /** Developer → work item: attribution can leave some unattributed. */
  const authored = (
    total: number,
    unattributed: number,
    withheld: number,
    noun: Noun,
  ): Pick<CoverageRow, 'status' | 'explanation'> => {
    if (!repo) {
      return tenantScope(tenantCount('CREATED'), 'authorship edges');
    }
    if (total === 0) {
      return {
        status: 'no_data',
        explanation: `No ${noun} in this repository inside the loaded window.`,
      };
    }
    const withheldNote = withheld
      ? ` ${withheld} by bots, anonymized or admin-excluded identities are counted but never named.`
      : '';
    if (unattributed > 0) {
      return {
        status: 'partial',
        explanation: `${unattributed} of ${total} ${noun} have no author that resolves to a known developer; they are reported as unattributed, never assigned to anyone.${withheldNote}`,
      };
    }
    return {
      status: 'available',
      explanation: `Every one of the ${total} ${noun} resolves to an author.${withheldNote}`,
    };
  };

  const recorded = (
    total: number | undefined,
    noun: string,
    note = '',
  ): Pick<CoverageRow, 'status' | 'explanation'> => {
    if (total === undefined) {
      return tenantScope(tenantCount('BELONGS_TO'), 'containment edges');
    }
    return total > 0
      ? {
          status: 'available',
          explanation: `Recorded by the collectors for all ${total} ${noun}.${note}`,
        }
      : {
          status: 'no_data',
          explanation: `No ${noun} in this repository inside the loaded window.`,
        };
  };

  const issueLinks = (): Pick<CoverageRow, 'status' | 'explanation'> => {
    const how =
      'Made by correlation — a Jira key found in a PR title, branch or commit messages — and shown with its confidence score.';
    if (repo && input.activities) {
      const { jiraIssues, pullRequests } = input.activities;
      if (jiraIssues.total > 0) {
        return {
          status: 'available',
          explanation: `${jiraIssues.total} Jira issues linked to this repository's PRs. ${how}`,
        };
      }
      return {
        status: 'no_data',
        explanation:
          pullRequests.total > 0
            ? `None of this repository's ${pullRequests.total} PRs carries a Jira key that matched a known issue. ${how}`
            : 'No PRs in this repository inside the loaded window, so there is nothing to link.',
      };
    }
    const scope = tenantScope(tenantCount('REFERENCES'), 'PR → Jira links');
    return {
      ...scope,
      explanation: `${scope.explanation}${
        repo ? ' Open the activity tabs to check this repository.' : ''
      } ${how}`,
    };
  };

  const rows: CoverageRow[] = [
    {
      id: 'developer-commit',
      from: 'DEVELOPER',
      to: 'COMMIT',
      basis: 'recorded',
      ...authored(
        repo?.totals.commits ?? 0,
        repo?.unattributed.commits ?? 0,
        repo?.withheld.commits ?? 0,
        'commits',
      ),
    },
    {
      id: 'commit-repository',
      from: 'COMMIT',
      to: 'REPOSITORY',
      basis: 'recorded',
      ...recorded(repo?.totals.commits, 'commits'),
    },
    {
      id: 'developer-pull-request',
      from: 'DEVELOPER',
      to: 'PULL_REQUEST',
      basis: 'recorded',
      ...authored(
        repo?.totals.pullRequests ?? 0,
        repo?.unattributed.pullRequests ?? 0,
        repo?.withheld.pullRequests ?? 0,
        'pull requests',
      ),
    },
    {
      id: 'pull-request-repository',
      from: 'PULL_REQUEST',
      to: 'REPOSITORY',
      basis: 'recorded',
      ...recorded(repo?.totals.pullRequests, 'pull requests'),
    },
    {
      id: 'developer-review',
      from: 'DEVELOPER',
      to: 'REVIEW',
      basis: 'recorded',
      ...authored(
        repo?.totals.reviews ?? 0,
        repo?.unattributed.reviews ?? 0,
        repo?.withheld.reviews ?? 0,
        'reviews',
      ),
    },
    {
      id: 'review-pull-request',
      from: 'REVIEW',
      to: 'PULL_REQUEST',
      basis: 'recorded',
      ...recorded(
        repo?.totals.reviews,
        'reviews',
        ' A review outside the loaded PR page still links to its PR by number.',
      ),
    },
    {
      id: 'developer-repository',
      from: 'DEVELOPER',
      to: 'REPOSITORY',
      basis: 'derived',
      ...(repo
        ? repo.developers.length > 0
          ? {
              status: 'available' as const,
              explanation: `Derived by the backend from authorship: ${repo.developers.length} named developers have at least one commit, PR or review here.`,
            }
          : repo.totals.commits + repo.totals.pullRequests + repo.totals.reviews > 0
            ? {
                status: 'partial' as const,
                explanation:
                  'There is activity here, but none of it resolves to a developer who can be named.',
              }
            : {
                status: 'no_data' as const,
                explanation: 'No activity in this repository inside the loaded window.',
              }
        : tenantScope(tenantCount('CONTRIBUTED_TO'), 'contribution edges')),
    },
    {
      id: 'pull-request-jira',
      from: 'PULL_REQUEST',
      to: 'JIRA_ISSUE',
      basis: 'inferred',
      ...issueLinks(),
    },
    {
      id: 'jira-developer',
      from: 'JIRA_ISSUE',
      to: 'DEVELOPER',
      basis: 'recorded',
      ...(tenantCount('ASSIGNED_TO') > 0
        ? {
            status: 'partial' as const,
            explanation: `Available where the Jira assignee matches a developer (${tenantCount('ASSIGNED_TO')} tenant-wide); unmatched assignees are not linked. Shown in a developer's details as assigned issues, not per repository.`,
          }
        : {
            status: 'no_data' as const,
            explanation: 'No Jira assignee in the loaded window matches a known developer.',
          }),
    },
    {
      id: 'commit-jira',
      from: 'COMMIT',
      to: 'JIRA_ISSUE',
      basis: 'none',
      status: 'not_implemented',
      explanation:
        'Direct Commit → Jira Issue mapping is not currently available. Jira relationships are currently available through correlated Pull Requests.',
    },
    {
      id: 'developer-team',
      from: 'DEVELOPER',
      to: 'TEAM',
      basis: 'none',
      status: 'not_implemented',
      explanation: 'SprintIQ stores no team membership, so no developer is shown in a team.',
    },
    {
      id: 'team-repository',
      from: 'TEAM',
      to: 'REPOSITORY',
      basis: 'none',
      status: 'not_implemented',
      explanation: 'SprintIQ stores no repository ownership, so no team owns a repository.',
    },
    {
      id: 'feature-repository',
      from: 'FEATURE',
      to: 'REPOSITORY',
      basis: 'none',
      status: 'planned',
      explanation:
        'Feature discovery ("which repositories implement invoice generation?") is designed but not built.',
    },
  ];
  return rows;
}

function tenantScope(
  count: number,
  noun: string,
): Pick<CoverageRow, 'status' | 'explanation'> {
  return count > 0
    ? {
        status: 'available',
        explanation: `${count.toLocaleString('en-US')} ${noun} tenant-wide. Select a repository to see its coverage.`,
      }
    : {
        status: 'no_data',
        explanation: `No ${noun} in the loaded graph.`,
      };
}
