import { describe, expect, it } from 'vitest';
import {
  activitiesResponse,
  developersResponse,
  statusResponse,
} from './fixtures';
import { relationshipCoverage, type CoverageRow } from './relationship-coverage';

const row = (rows: CoverageRow[], id: string) => {
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};

describe('relationshipCoverage', () => {
  it('lists every documented relationship, including the unavailable ones', () => {
    const ids = relationshipCoverage({ status: statusResponse() }).map((r) => r.id);
    expect(ids).toEqual([
      'developer-commit',
      'commit-repository',
      'developer-pull-request',
      'pull-request-repository',
      'developer-review',
      'review-pull-request',
      'developer-repository',
      'pull-request-jira',
      'jira-developer',
      'commit-jira',
      'developer-team',
      'team-repository',
      'feature-repository',
    ]);
  });

  it('says Commit → Jira is not implemented, and where Jira links come from instead', () => {
    const commitJira = row(relationshipCoverage({}), 'commit-jira');
    expect(commitJira.status).toBe('not_implemented');
    expect(commitJira.explanation).toContain(
      'Jira relationships are currently available through correlated Pull Requests',
    );
  });

  it('marks teams not implemented and features planned, regardless of data', () => {
    const rows = relationshipCoverage({
      status: statusResponse(),
      repository: developersResponse(),
      activities: activitiesResponse(),
    });
    expect(row(rows, 'developer-team').status).toBe('not_implemented');
    expect(row(rows, 'team-repository').status).toBe('not_implemented');
    expect(row(rows, 'feature-repository').status).toBe('planned');
  });

  it('reports partial attribution when some work has no resolvable author', () => {
    const r = row(
      relationshipCoverage({ repository: developersResponse() }),
      'developer-commit',
    );
    expect(r.status).toBe('partial');
    expect(r.explanation).toContain('1 of 13 commits have no author');
    expect(r.explanation).toContain('1 by bots, anonymized or admin-excluded identities');
  });

  it('separates an implemented relationship with no data from a missing one', () => {
    const empty = developersResponse({
      developers: [],
      totals: { commits: 0, pullRequests: 0, reviews: 0 },
      unattributed: { commits: 0, pullRequests: 0, reviews: 0 },
      withheld: { commits: 0, pullRequests: 0, reviews: 0, identities: 0 },
    });
    const rows = relationshipCoverage({ repository: empty });
    expect(row(rows, 'developer-commit').status).toBe('no_data');
    expect(row(rows, 'developer-repository').status).toBe('no_data');
    expect(row(rows, 'commit-jira').status).toBe('not_implemented');
  });

  it('calls PR → Jira inferred, and checks it against the loaded activities', () => {
    const withLinks = row(
      relationshipCoverage({ repository: developersResponse(), activities: activitiesResponse() }),
      'pull-request-jira',
    );
    expect(withLinks).toMatchObject({ basis: 'inferred', status: 'available' });

    const without = row(
      relationshipCoverage({
        repository: developersResponse(),
        activities: activitiesResponse({ jiraIssues: { total: 0, items: [] } }),
      }),
      'pull-request-jira',
    );
    expect(without.status).toBe('no_data');
    expect(without.explanation).toContain('None of this repository');
  });

  it('falls back to tenant-wide counts before a repository is selected', () => {
    const r = row(relationshipCoverage({ status: statusResponse() }), 'developer-commit');
    expect(r.status).toBe('available');
    expect(r.explanation).toContain('Select a repository');
  });

  it('marks activity with no nameable developer as partial, not as no data', () => {
    const r = row(
      relationshipCoverage({ repository: developersResponse({ developers: [] }) }),
      'developer-repository',
    );
    expect(r.status).toBe('partial');
  });
});
