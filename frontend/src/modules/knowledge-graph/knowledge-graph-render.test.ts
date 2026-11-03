import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { ActivityTabsView, type ActivityTab } from './ActivityTabs';
import {
  DeveloperDetailsView,
  EdgeDetailsView,
  EntityDetailsView,
  RepositoryDetailsView,
} from './DetailsPanels';
import {
  activitiesResponse,
  developerReposResponse,
  developersResponse,
  RULE,
  statusResponse,
} from './fixtures';
import { GraphBreadcrumb, GraphLegend } from './GraphChrome';
import { developerActivityExpansion, nodeIds } from './graph-model';
import { graphReadiness } from './graph-status';
import { relationshipCoverage } from './relationship-coverage';
import { GraphStatusView, RelationshipCoverageView } from './StatusPanels';

const noop = () => undefined;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
/** Markup with tags stripped, for asserting on the words a reader sees. */
const text = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  html(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('GraphStatusView', () => {
  it('shows readiness, window, build time, last update and node counts', () => {
    const status = statusResponse();
    const out = text(
      createElement(GraphStatusView, { readiness: graphReadiness(status, null), status }),
    );
    expect(out).toContain('Ready');
    expect(out).toContain('History window: 90 days');
    expect(out).toContain('Last update: none since build');
    expect(out).toContain('41,188 nodes');
    expect(out).toContain('Commits: 15,993');
    // Reserved types are never listed as if they had data.
    expect(out).not.toContain('Teams:');
    expect(out).not.toContain('Features:');
  });

  it('explains initialization instead of showing counts', () => {
    const status = statusResponse({ state: 'building', builtAt: null }, 'initializing');
    const out = text(
      createElement(GraphStatusView, { readiness: graphReadiness(status, null), status }),
    );
    expect(out).toContain('being built');
    expect(out).not.toContain('nodes ·');
  });

  it('turns a 503 into an initializing message', () => {
    const out = text(
      createElement(GraphStatusView, {
        readiness: graphReadiness(undefined, new ApiError(503, 'Knowledge graph initializing')),
        status: undefined,
      }),
    );
    expect(out).toContain('still being built');
  });

  it('flags a stale graph', () => {
    const status = statusResponse({ stale: true });
    const out = text(
      createElement(GraphStatusView, { readiness: graphReadiness(status, null), status }),
    );
    expect(out).toContain('Stale');
    expect(out).toContain('some recent activity may be missing');
  });
});

describe('RelationshipCoverageView', () => {
  it('lists missing relationships with their reason, not just the available ones', () => {
    const out = text(
      createElement(RelationshipCoverageView, {
        rows: relationshipCoverage({ status: statusResponse(), repository: developersResponse() }),
        scope: 'For acme/invoice-service',
        defaultOpen: true,
      }),
    );
    expect(out).toContain('Commit → Jira issue');
    expect(out).toContain('Not implemented');
    expect(out).toContain('Direct Commit → Jira Issue mapping is not currently available');
    expect(out).toContain('Developer → Team');
    expect(out).toContain('Feature → Repository');
    expect(out).toContain('Planned');
    expect(out).toContain('Partially available');
    expect(out).toContain('Inferred (confidence-scored)');
  });

  it('is collapsed by default, with a count of gaps', () => {
    const out = text(
      createElement(RelationshipCoverageView, {
        rows: relationshipCoverage({ status: statusResponse() }),
        scope: 'Tenant-wide',
      }),
    );
    expect(out).toMatch(/\d+ of 13 not fully available/);
    expect(out).not.toContain('What it means');
  });
});

describe('RepositoryDetailsView', () => {
  it('lists developers alphabetically with their counts, and shows unattributed work separately', () => {
    // Reversed on purpose: the view must not trust the order it is handed.
    const view = developersResponse();
    view.developers = [...view.developers].reverse();
    const markup = html(createElement(RepositoryDetailsView, { view, onSelectDeveloper: noop }));
    const out = markup.replace(/<[^>]+>/g, ' ');
    expect(out.indexOf('Asha Rao')).toBeLessThan(out.indexOf('Dev Kumar'));
    expect(out).toContain('alphabetical');
    expect(out).toMatch(/Unattributed commits\s+1/);
    expect(out).toMatch(/Unattributed reviews\s+0/);
    expect(out).toContain('https://github.com/acme/invoice-service');
    expect(out).toContain(RULE);
  });

  it('counts withheld identities without naming them', () => {
    const out = text(
      createElement(RepositoryDetailsView, { view: developersResponse(), onSelectDeveloper: noop }),
    );
    expect(out).toContain('Withheld identities 1 (1 commits, 0 PRs, 1 reviews)');
  });
});

describe('DeveloperDetailsView (reverse lookup)', () => {
  const render = (over: Partial<Parameters<typeof DeveloperDetailsView>[0]> = {}) =>
    text(
      createElement(DeveloperDetailsView, {
        displayName: 'Asha Rao',
        view: developerReposResponse(),
        loading: false,
        errorMessage: null,
        contextRepoId: 'acme/invoice-service',
        expandedHere: false,
        onShowActivityHere: noop,
        onExploreFromDeveloper: noop,
        onOpenRepository: noop,
        ...over,
      }),
    );

  it('lists their repositories with commits, PRs created and reviewed, Jira keys and last date', () => {
    const out = render();
    expect(out).toContain('acme/invoice-service');
    expect(out).toContain('acme/ledger');
    expect(out).toContain('2 commits · 1 PRs created · 0 PRs reviewed · last 2026-10-31');
    expect(out).toContain('Jira (via their PRs): BILL-482');
    expect(out).toContain('BILL-501');
    expect(out).toContain('Explore from this developer');
  });

  it('offers the in-repository expansion only when reached from a repository', () => {
    expect(render()).toContain('Show activity in this repository');
    expect(render({ contextRepoId: null })).not.toContain('Show activity in this repository');
    expect(render({ expandedHere: true })).toContain('Activity shown in graph');
  });

  it('shows a 404 for a withheld identity as the server worded it', () => {
    const out = render({ view: undefined, errorMessage: 'Developer "bot" is withheld (automation, anonymized or admin-excluded).' });
    expect(out).toContain('is withheld');
  });
});

describe('ActivityTabsView', () => {
  const render = (initialTab: ActivityTab) =>
    text(
      createElement(ActivityTabsView, {
        activities: activitiesResponse(),
        loading: false,
        errorMessage: null,
        onReveal: noop,
        initialTab,
      }),
    );

  it('shows commits with SHA, date, author and repository, never naming withheld work', () => {
    const out = render('commits');
    expect(out).toContain('aaaaaaa');
    expect(out).toContain('2026-10-31');
    expect(out).toContain('Asha Rao');
    expect(out).toContain('Withheld');
    expect(out).toContain('Unattributed');
    expect(out).toContain('acme/invoice-service');
    expect(out).toContain('All 4 commits in the loaded window.');
  });

  it('shows PRs with number, title, state, author and dates', () => {
    const out = render('pullRequests');
    expect(out).toContain('#312');
    expect(out).toContain('BILL-482 credit-note invoices');
    expect(out).toContain('merged');
    expect(out).toContain('2026-10-28');
  });

  it('shows reviews with reviewer, state, date and PR', () => {
    const out = render('reviews');
    expect(out).toContain('Dev Kumar');
    expect(out).toContain('approved');
    expect(out).toContain('#298');
  });

  it('shows Jira issues with link confidence and method', () => {
    expect(render('jiraIssues')).toContain('#312 · 80% · regex');
  });

  it('says when a list is the newest slice of a longer one', () => {
    const a = activitiesResponse();
    a.commits.total = 950;
    const out = text(
      createElement(ActivityTabsView, { activities: a, loading: false, errorMessage: null, onReveal: noop }),
    );
    expect(out).toContain('The 4 newest of 950 commits');
  });

  it('explains an empty Jira list instead of showing an empty table', () => {
    const out = text(
      createElement(ActivityTabsView, {
        activities: activitiesResponse({ jiraIssues: { total: 0, items: [] } }),
        loading: false,
        errorMessage: null,
        onReveal: noop,
        initialTab: 'jiraIssues',
      }),
    );
    expect(out).toContain('Commits are not linked to Jira directly');
  });
});

describe('graph chrome and details', () => {
  it('lists only drawable entity types in the legend', () => {
    const out = text(createElement(GraphLegend));
    for (const label of ['Repository', 'Developer', 'Commit', 'Pull request', 'Review', 'Jira issue']) {
      expect(out).toContain(label);
    }
    expect(out).not.toContain('Team');
    expect(out).not.toContain('Feature');
  });

  it('renders the breadcrumb with the current step marked', () => {
    const markup = html(
      createElement(GraphBreadcrumb, {
        crumbs: [
          { key: 'repo:acme/invoice-service', type: 'REPOSITORY', label: 'acme/invoice-service' },
          { key: 'dev:asha', type: 'DEVELOPER', label: 'Asha Rao' },
        ],
        onNavigate: noop,
      }),
    );
    expect(markup).toContain('aria-current="page"');
    expect(markup.replace(/<[^>]+>/g, ' ')).toContain('Developer: Asha Rao');
  });

  it('shows a PR known only from a review as such', () => {
    const g = developerActivityExpansion(activitiesResponse(), 'dev');
    const outside = g.nodes.find((n) => n.id === nodeIds.pullRequest('acme/invoice-service', '298'));
    if (!outside) throw new Error('missing node');
    const out = text(createElement(EntityDetailsView, { node: outside, onExpandPullRequest: noop }));
    expect(out).toContain('outside the newest activity loaded');
  });

  it('shows an edge with its correlation confidence and method', () => {
    const g = developerActivityExpansion(activitiesResponse(), 'asha');
    const link = g.edges.find((e) => e.relation === 'REFERENCES');
    if (!link) throw new Error('missing edge');
    const out = text(
      createElement(EdgeDetailsView, {
        edge: link,
        source: g.nodes.find((n) => n.id === link.source),
        target: g.nodes.find((n) => n.id === link.target),
      }),
    );
    expect(out).toContain('#312 references BILL-482');
    expect(out).toContain('80%');
    expect(out).toContain('regex');
  });
});
