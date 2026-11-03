import type { ReactNode } from 'react';
import { Badge, Button, Spinner, TableBodyRow, TableHeadRow } from '../../components/ui';
import type {
  Attribution,
  DeveloperRepositoriesResponse,
  RepositoryDevelopersResponse,
} from './api';
import {
  ENTITY_REGISTRY,
  RELATION_REGISTRY,
  type EntityType,
} from './entity-registry';
import { formatCount, formatDay, shortSha } from './format';
import { EntitySwatch } from './GraphChrome';
import type { NodeDetail, VizEdge, VizNode } from './graph-model';
import { alphabetical } from './presentation';
import { AttributionRule } from './StatusPanels';

function SectionHead({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-fg-muted">
      {children}
    </h3>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1 text-sm">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="text-right text-fg">{value}</dd>
    </div>
  );
}

function PanelTitle({ type, title, sub }: { type: EntityType; title: string; sub?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start gap-2">
      <EntitySwatch type={type} />
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">
          {ENTITY_REGISTRY[type].label}
        </p>
        <p className="break-words text-base font-bold tracking-[-0.02em] text-fg">{title}</p>
        {sub && <p className="text-xs text-fg-subtle">{sub}</p>}
      </div>
    </div>
  );
}

/** The selected repository: its developers (alphabetical) and the counts behind them. */
export function RepositoryDetailsView({
  view,
  onSelectDeveloper,
}: {
  view: RepositoryDevelopersResponse;
  onSelectDeveloper: (developerId: string) => void;
}) {
  const { repository, totals, unattributed, withheld } = view;
  const developers = alphabetical(view.developers);
  return (
    <div className="space-y-4">
      <PanelTitle
        type="REPOSITORY"
        title={repository.fullName}
        sub={
          <a href={repository.url} target="_blank" rel="noreferrer" className="text-brand hover:underline">
            {repository.url}
          </a>
        }
      />
      <dl>
        <Fact label="Commits" value={formatCount(totals.commits)} />
        <Fact label="Pull requests" value={formatCount(totals.pullRequests)} />
        <Fact label="Reviews" value={formatCount(totals.reviews)} />
        <Fact label="Unattributed commits" value={formatCount(unattributed.commits)} />
        <Fact label="Unattributed reviews" value={formatCount(unattributed.reviews)} />
        {withheld.identities > 0 && (
          <Fact
            label="Withheld identities"
            value={`${withheld.identities} (${formatCount(withheld.commits)} commits, ${formatCount(withheld.pullRequests)} PRs, ${formatCount(withheld.reviews)} reviews)`}
          />
        )}
      </dl>
      <div>
        <SectionHead>Developers ({developers.length}) · alphabetical</SectionHead>
        {developers.length === 0 ? (
          <p className="text-sm text-fg-subtle">
            No developer who can be named has activity here in the loaded window.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <TableHeadRow>
                <th className="py-1.5 pr-2">Developer</th>
                <th className="py-1.5 pr-2 text-right">Commits</th>
                <th className="py-1.5 pr-2 text-right">PRs</th>
                <th className="py-1.5 pr-2 text-right">Reviews</th>
                <th className="py-1.5 text-right">Last</th>
              </TableHeadRow>
            </thead>
            <tbody>
              {developers.map((d) => (
                <TableBodyRow key={d.developerId}>
                  <td className="py-1.5 pr-2">
                    <button
                      type="button"
                      onClick={() => onSelectDeveloper(d.developerId)}
                      className="text-left text-brand hover:underline"
                    >
                      {d.displayName}
                    </button>
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{d.commitCount}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{d.pullRequestCount}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{d.reviewCount}</td>
                  <td className="py-1.5 text-right text-xs text-fg-subtle">
                    {formatDay(d.lastContributionAt)}
                  </td>
                </TableBodyRow>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <AttributionRule rule={view.rule} />
    </div>
  );
}

/** A developer's repositories (the reverse lookup). */
export function DeveloperDetailsView({
  displayName,
  view,
  loading,
  errorMessage,
  contextRepoId,
  expandedHere,
  onShowActivityHere,
  onExploreFromDeveloper,
  onOpenRepository,
}: {
  displayName: string;
  view: DeveloperRepositoriesResponse | undefined;
  loading: boolean;
  errorMessage: string | null;
  /** The repository in focus, when the developer was reached from one. */
  contextRepoId: string | null;
  expandedHere: boolean;
  onShowActivityHere: () => void;
  onExploreFromDeveloper: () => void;
  onOpenRepository: (repoId: string, fullName: string) => void;
}) {
  return (
    <div className="space-y-4">
      <PanelTitle type="DEVELOPER" title={view?.developer.displayName ?? displayName} />
      <div className="flex flex-wrap gap-2">
        {contextRepoId && (
          <Button size="sm" onClick={onShowActivityHere} disabled={expandedHere}>
            {expandedHere ? 'Activity shown in graph' : 'Show activity in this repository'}
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={onExploreFromDeveloper}>
          Explore from this developer
        </Button>
      </div>
      {loading && <Spinner />}
      {errorMessage && <p className="text-sm text-danger-fg">{errorMessage}</p>}
      {view && (
        <>
          <div>
            <SectionHead>Repositories ({view.repositories.length})</SectionHead>
            <ul className="space-y-3">
              {view.repositories.map((r) => (
                <li key={r.id} className="border-b border-border-subtle pb-2 last:border-0">
                  <button
                    type="button"
                    onClick={() => onOpenRepository(r.id, r.fullName)}
                    className="text-left text-sm font-medium text-brand hover:underline"
                  >
                    {r.fullName}
                  </button>
                  <p className="text-xs text-fg-subtle">
                    {r.commitCount} commits · {r.pullRequestsCreated} PRs created ·{' '}
                    {r.pullRequestsReviewed} PRs reviewed · last {formatDay(r.lastContributionAt)}
                  </p>
                  {r.jiraIssues.length > 0 && (
                    <p className="mt-0.5 text-xs text-fg-subtle">
                      Jira (via their PRs):{' '}
                      {r.jiraIssues.map((i) => i.key).join(', ')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <SectionHead>Assigned Jira issues ({view.assignedIssues.length})</SectionHead>
            {view.assignedIssues.length === 0 ? (
              <p className="text-xs text-fg-subtle">
                None in the loaded window, or the Jira assignee could not be matched to this developer.
              </p>
            ) : (
              <ul className="space-y-1 text-xs">
                {view.assignedIssues.map((i) => (
                  <li key={i.key}>
                    <span className="font-medium text-fg">{i.key}</span>{' '}
                    <span className="text-fg-subtle">
                      {i.title} · {i.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <AttributionRule rule={view.rule} />
        </>
      )}
    </div>
  );
}

function authorText(item: Attribution): string {
  switch (item.attribution) {
    case 'person':
      return item.author.displayName;
    case 'withheld':
      return 'Withheld (automation, anonymized or admin-excluded)';
    case 'unattributed':
      return 'Unattributed (no known developer)';
  }
}

type DetailRenderer = (
  detail: NodeDetail,
  actions: { onExpandPullRequest: (number: string) => void },
) => ReactNode;

/**
 * Details for activity entities, keyed by registry type. A new entity type
 * adds an entry here; nothing else in the panel changes.
 */
const DETAIL_RENDERERS: Partial<Record<EntityType, DetailRenderer>> = {
  COMMIT: (detail) =>
    detail.kind === 'commit' && (
      <>
        <PanelTitle type="COMMIT" title={shortSha(detail.commit.sha)} sub={detail.repoId} />
        <dl>
          <Fact label="SHA" value={<code className="font-mono text-xs">{detail.commit.sha}</code>} />
          <Fact label="Authored" value={formatDay(detail.commit.authoredAt)} />
          <Fact label="Author" value={authorText(detail.commit)} />
          <Fact
            label="Merge commit"
            value={detail.commit.isMerge === null ? 'Unknown' : detail.commit.isMerge ? 'Yes' : 'No'}
          />
        </dl>
        <p className="mt-3 text-xs text-fg-subtle">
          Commits are not linked to Jira issues directly; see Relationship coverage.
        </p>
      </>
    ),
  PULL_REQUEST: (detail, { onExpandPullRequest }) =>
    detail.kind === 'pull_request' && (
      <>
        <PanelTitle
          type="PULL_REQUEST"
          title={`#${detail.number}${detail.pullRequest ? ` ${detail.pullRequest.title}` : ''}`}
          sub={detail.repoId}
        />
        {detail.pullRequest ? (
          <dl>
            <Fact label="State" value={<Badge>{detail.pullRequest.state}</Badge>} />
            <Fact label="Author" value={authorText(detail.pullRequest)} />
            <Fact label="Opened" value={formatDay(detail.pullRequest.openedAt)} />
            <Fact label="Merged" value={formatDay(detail.pullRequest.mergedAt)} />
            <Fact
              label="Jira"
              value={detail.pullRequest.jiraKeys.length ? detail.pullRequest.jiraKeys.join(', ') : 'None linked'}
            />
          </dl>
        ) : (
          <p className="text-sm text-fg-subtle">
            Known only from a review that names it: the PR itself is outside the newest
            activity loaded for this repository.
          </p>
        )}
        <Button size="sm" className="mt-3" onClick={() => onExpandPullRequest(detail.number)}>
          Show reviews and Jira issues
        </Button>
      </>
    ),
  REVIEW: (detail) =>
    detail.kind === 'review' && (
      <>
        <PanelTitle type="REVIEW" title={detail.review.state.replace(/_/g, ' ')} sub={`on PR #${detail.review.prNumber}`} />
        <dl>
          <Fact label="Reviewer" value={authorText(detail.review)} />
          <Fact label="Submitted" value={formatDay(detail.review.submittedAt)} />
          <Fact label="Pull request" value={`#${detail.review.prNumber}`} />
        </dl>
      </>
    ),
  JIRA_ISSUE: (detail) =>
    detail.kind === 'jira_issue' && (
      <>
        <PanelTitle type="JIRA_ISSUE" title={detail.key} sub={detail.title || undefined} />
        <dl>
          <Fact label="Status" value={detail.status || '—'} />
          <Fact label="Type" value={detail.type || '—'} />
        </dl>
        <p className="mt-3 text-xs text-fg-subtle">
          Linked through correlated pull requests; select an edge to see its confidence.
        </p>
      </>
    ),
  REPOSITORY: (detail) =>
    detail.kind === 'repository' && (
      <PanelTitle
        type="REPOSITORY"
        title={detail.repository.fullName}
        sub={detail.repository.url}
      />
    ),
};

export function EntityDetailsView({
  node,
  onExpandPullRequest,
}: {
  node: VizNode;
  onExpandPullRequest: (number: string) => void;
}) {
  const render = DETAIL_RENDERERS[node.type];
  return <div>{render ? render(node.detail, { onExpandPullRequest }) : null}</div>;
}

export function EdgeDetailsView({
  edge,
  source,
  target,
}: {
  edge: VizEdge;
  source: VizNode | undefined;
  target: VizNode | undefined;
}) {
  const relation = RELATION_REGISTRY[edge.relation];
  return (
    <div className="space-y-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">Relationship</p>
      <p className="text-sm text-fg">
        <span className="font-semibold">{source?.label ?? edge.source}</span>{' '}
        <span className="text-fg-subtle">{relation.label}</span>{' '}
        <span className="font-semibold">{target?.label ?? edge.target}</span>
      </p>
      <dl>
        {edge.confidence !== undefined && (
          <Fact label="Confidence" value={`${Math.round(edge.confidence * 100)}%`} />
        )}
        {edge.method && <Fact label="Method" value={edge.method} />}
      </dl>
      <p className="text-xs text-fg-subtle">{relation.description}</p>
    </div>
  );
}
