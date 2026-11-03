import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Card, Spinner } from '../../components/ui';
import { ActivityTabsView } from './ActivityTabs';
import {
  useDeveloperRepositories,
  useGraphStatus,
  useRepositoryActivities,
  useRepositoryDevelopers,
  ACTIVITY_LIMIT,
} from './api';
import {
  DeveloperDetailsView,
  EdgeDetailsView,
  EntityDetailsView,
  RepositoryDetailsView,
} from './DetailsPanels';
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas';
import {
  GraphBreadcrumb,
  GraphLegend,
  GraphToolbar,
  type Crumb,
} from './GraphChrome';
import {
  composeGraph,
  developerGraph,
  emptyGraph,
  EXPANSION_CAP,
  hasExpansions,
  NO_EXPANSIONS,
  nodeIds,
  repositoryGraph,
  type ActivityItemRef,
  type Expansions,
} from './graph-model';
import { dataErrorMessage, graphReadiness } from './graph-status';
import { relationshipCoverage } from './relationship-coverage';
import { RepositorySearch } from './RepositorySearch';
import { GraphStatusView, RelationshipCoverageView } from './StatusPanels';

type Focus =
  | { kind: 'repository'; repoId: string; label: string }
  | { kind: 'developer'; developerId: string; label: string };

type Selection = { kind: 'node' | 'edge'; id: string } | null;

function focusCrumb(focus: Focus): Crumb {
  return focus.kind === 'repository'
    ? { key: `repo:${focus.repoId}`, type: 'REPOSITORY', label: focus.label }
    : { key: `dev:${focus.developerId}`, type: 'DEVELOPER', label: focus.label };
}

/** Focus lives in the URL, so an exploration can be shared or reloaded. */
function focusFromParams(params: URLSearchParams): Focus | null {
  const repo = params.get('repo');
  if (repo) {
    return { kind: 'repository', repoId: repo, label: params.get('name') ?? repo };
  }
  const developer = params.get('developer');
  if (developer) {
    return {
      kind: 'developer',
      developerId: developer,
      label: params.get('name') ?? developer,
    };
  }
  return null;
}

function focusToParams(focus: Focus): Record<string, string> {
  return focus.kind === 'repository'
    ? { repo: focus.repoId, name: focus.label }
    : { developer: focus.developerId, name: focus.label };
}

/**
 * Engineering Intelligence → Knowledge Graph (admin only, ADR-0013).
 *
 * Search-first and progressive: a repository and its developers, then what
 * the reader chooses to expand. Every node and edge comes from the
 * knowledge-graph API; the page derives none (features/ANALYTICS.md §8).
 */
export function KnowledgeGraphPage() {
  const [params, setParams] = useSearchParams();
  const focus = focusFromParams(params);
  const [crumbs, setCrumbs] = useState<Crumb[]>(() => (focus ? [focusCrumb(focus)] : []));
  const [expansions, setExpansions] = useState<Expansions>(NO_EXPANSIONS);
  const [needActivities, setNeedActivities] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [showEdgeLabels, setShowEdgeLabels] = useState(false);
  const canvas = useRef<GraphCanvasHandle>(null);

  const status = useGraphStatus();
  const readiness = graphReadiness(status.data, status.error);
  const ready = readiness.phase === 'ready';

  const repoId = ready && focus?.kind === 'repository' ? focus.repoId : null;
  const focusDeveloperId = ready && focus?.kind === 'developer' ? focus.developerId : null;
  const repoDevelopers = useRepositoryDevelopers(repoId);
  const activities = useRepositoryActivities(repoId, needActivities);
  const focusDeveloper = useDeveloperRepositories(focusDeveloperId);

  // A new focus starts a clean exploration.
  const focusKey = focus ? focusCrumb(focus).key : '';
  useEffect(() => {
    setExpansions(NO_EXPANSIONS);
    setNeedActivities(false);
    setSelection(null);
  }, [focusKey]);

  const base = useMemo(() => {
    if (focus?.kind === 'repository' && repoDevelopers.data) {
      return repositoryGraph(repoDevelopers.data);
    }
    if (focus?.kind === 'developer' && focusDeveloper.data) {
      return developerGraph(focusDeveloper.data);
    }
    return emptyGraph();
  }, [focus?.kind, repoDevelopers.data, focusDeveloper.data]);

  const graph = useMemo(
    () =>
      focus?.kind === 'repository'
        ? composeGraph(base, activities.data, expansions)
        : base,
    [focus?.kind, base, activities.data, expansions],
  );

  const rootId = focus
    ? focus.kind === 'repository'
      ? nodeIds.repository(focus.repoId)
      : nodeIds.developer(focus.developerId)
    : null;

  const selectedNode =
    selection?.kind === 'node' ? graph.nodes.find((n) => n.id === selection.id) : undefined;
  const selectedEdge =
    selection?.kind === 'edge' ? graph.edges.find((e) => e.id === selection.id) : undefined;
  const selectedDeveloperId =
    selectedNode?.detail.kind === 'developer' ? selectedNode.detail.developerId : null;
  // The reverse lookup for a developer selected inside a repository graph.
  const selectedDeveloper = useDeveloperRepositories(
    selectedDeveloperId && selectedDeveloperId !== focusDeveloperId ? selectedDeveloperId : null,
  );

  const navigate = (next: Focus, history: Crumb[]) => {
    setCrumbs(history);
    setParams(focusToParams(next));
  };
  const openRepository = (id: string, label: string) => {
    const next: Focus = { kind: 'repository', repoId: id, label };
    navigate(next, [...crumbs, focusCrumb(next)]);
  };
  const openDeveloper = (developerId: string, label: string) => {
    const next: Focus = { kind: 'developer', developerId, label };
    navigate(next, [...crumbs, focusCrumb(next)]);
  };
  const onCrumb = (index: number) => {
    const crumb = crumbs[index];
    const next: Focus = crumb.key.startsWith('repo:')
      ? { kind: 'repository', repoId: crumb.key.slice(5), label: crumb.label }
      : { kind: 'developer', developerId: crumb.key.slice(4), label: crumb.label };
    navigate(next, crumbs.slice(0, index + 1));
  };

  const expandDeveloper = (developerId: string) => {
    setNeedActivities(true);
    setExpansions((e) =>
      e.developers.includes(developerId) ? e : { ...e, developers: [...e.developers, developerId] },
    );
  };
  const expandPullRequest = (number: string) => {
    setNeedActivities(true);
    setExpansions((e) =>
      e.pullRequests.includes(number) ? e : { ...e, pullRequests: [...e.pullRequests, number] },
    );
  };
  const reveal = (item: ActivityItemRef) => {
    if (!repoId) return;
    setNeedActivities(true);
    setExpansions((e) => ({ ...e, items: [...e.items, item] }));
    setSelection({
      kind: 'node',
      id:
        item.kind === 'commit'
          ? nodeIds.commit(repoId, item.sha)
          : item.kind === 'pull_request'
            ? nodeIds.pullRequest(repoId, item.number)
            : nodeIds.jiraIssue(item.key),
    });
  };

  /** Double-click: what "expand" means depends on the node and the focus. */
  const expandNode = (id: string) => {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return;
    const d = node.detail;
    if (d.kind === 'developer' && focus?.kind === 'repository') expandDeveloper(d.developerId);
    else if (d.kind === 'repository' && focus?.kind === 'developer')
      openRepository(d.repository.id, d.repository.fullName);
    else if (d.kind === 'pull_request' && focus?.kind === 'repository') expandPullRequest(d.number);
  };

  const reset = () => {
    setExpansions(NO_EXPANSIONS);
    setSelection(null);
    canvas.current?.relayout();
  };

  const coverageRows = relationshipCoverage({
    status: status.data,
    repository: focus?.kind === 'repository' ? repoDevelopers.data : undefined,
    activities: activities.data,
  });
  const freshness =
    activities.data?.freshness ?? repoDevelopers.data?.freshness ?? focusDeveloper.data?.freshness;
  const focusQuery = focus?.kind === 'repository' ? repoDevelopers : focusDeveloper;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header>
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-fg-muted">
          Engineering Intelligence
        </p>
        <h2 className="text-xl font-bold tracking-[-0.035em] text-fg">Knowledge Graph Explorer</h2>
        <p className="mt-1 max-w-3xl text-sm text-fg-subtle">
          Who worked on a repository, on what, and where else they worked — drawn only from
          relationships SprintIQ has recorded or correlated. Admin only; every view that names
          people is audit-logged.
        </p>
      </header>

      <Card>
        <GraphStatusView readiness={readiness} status={status.data} freshness={freshness} />
      </Card>

      {ready && (
        <>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <RepositorySearch
              value={focus?.kind === 'repository' ? focus.repoId : null}
              currentLabel={focus?.kind === 'repository' ? focus.label : null}
              onSelect={(id, label) => openRepository(id, label)}
            />
            <GraphBreadcrumb crumbs={crumbs} onNavigate={onCrumb} />
          </div>

          {!focus ? (
            <Card>
              <p className="text-sm text-fg-subtle">
                Search for a repository to start. The graph opens on the repository and the
                developers who worked in it; expand a developer to see their commits, pull
                requests and reviews, or select one to see every repository they worked in.
              </p>
            </Card>
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                <Card className="flex flex-col gap-3">
                  <GraphToolbar
                    onZoomIn={() => canvas.current?.zoomIn()}
                    onZoomOut={() => canvas.current?.zoomOut()}
                    onFit={() => canvas.current?.fit()}
                    onReset={reset}
                    showEdgeLabels={showEdgeLabels}
                    onToggleEdgeLabels={() => setShowEdgeLabels((v) => !v)}
                    canReset={hasExpansions(expansions) || selection !== null}
                  />
                  <div className="relative h-[520px] border border-border-subtle">
                    {focusQuery.isLoading && (
                      <div className="absolute inset-0 z-10 grid place-items-center bg-surface/70">
                        <Spinner />
                      </div>
                    )}
                    {focusQuery.error ? (
                      <p className="p-4 text-sm text-danger-fg">{dataErrorMessage(focusQuery.error)}</p>
                    ) : (
                      <GraphCanvas
                        ref={canvas}
                        graph={graph}
                        rootId={rootId}
                        selectedId={selection?.id ?? null}
                        showEdgeLabels={showEdgeLabels}
                        onSelectNode={(id) => setSelection(id ? { kind: 'node', id } : null)}
                        onSelectEdge={(id) => setSelection({ kind: 'edge', id })}
                        onExpandNode={expandNode}
                      />
                    )}
                  </div>
                  <GraphLegend />
                  <p className="text-xs text-fg-subtle">
                    Select a node for details; double-click to expand it. Expanding a developer adds
                    up to {EXPANSION_CAP} of their newest commits, PRs and reviews each, from the{' '}
                    {ACTIVITY_LIMIT} newest of this repository.
                    {needActivities && activities.isLoading && ' Loading activity…'}
                    {activities.error ? ` ${dataErrorMessage(activities.error)}` : null}
                  </p>
                </Card>

                <Card className="max-h-[680px] overflow-auto">
                  {selectedEdge ? (
                    <EdgeDetailsView
                      edge={selectedEdge}
                      source={graph.nodes.find((n) => n.id === selectedEdge.source)}
                      target={graph.nodes.find((n) => n.id === selectedEdge.target)}
                    />
                  ) : selectedNode?.detail.kind === 'developer' ? (
                    <DeveloperDetailsView
                      displayName={selectedNode.detail.displayName}
                      view={
                        selectedNode.detail.developerId === focusDeveloperId
                          ? focusDeveloper.data
                          : selectedDeveloper.data
                      }
                      loading={selectedDeveloper.isLoading}
                      errorMessage={selectedDeveloper.error ? dataErrorMessage(selectedDeveloper.error) : null}
                      contextRepoId={repoId}
                      expandedHere={expansions.developers.includes(selectedNode.detail.developerId)}
                      onShowActivityHere={() =>
                        selectedNode.detail.kind === 'developer' &&
                        expandDeveloper(selectedNode.detail.developerId)
                      }
                      onExploreFromDeveloper={() =>
                        selectedNode.detail.kind === 'developer' &&
                        openDeveloper(selectedNode.detail.developerId, selectedNode.detail.displayName)
                      }
                      onOpenRepository={openRepository}
                    />
                  ) : selectedNode && !(selectedNode.id === rootId && repoDevelopers.data) ? (
                    <div className="space-y-3">
                      <EntityDetailsView node={selectedNode} onExpandPullRequest={expandPullRequest} />
                      {selectedNode.detail.kind === 'repository' && focus.kind === 'developer' && (
                        <Button
                          size="sm"
                          onClick={() =>
                            selectedNode.detail.kind === 'repository' &&
                            openRepository(selectedNode.detail.repository.id, selectedNode.detail.repository.fullName)
                          }
                        >
                          Open this repository
                        </Button>
                      )}
                    </div>
                  ) : selection?.kind === 'node' && !selectedNode ? (
                    <p className="text-sm text-fg-subtle">Loading the selected activity…</p>
                  ) : focus.kind === 'repository' && repoDevelopers.data ? (
                    <RepositoryDetailsView
                      view={repoDevelopers.data}
                      onSelectDeveloper={(id) => setSelection({ kind: 'node', id: nodeIds.developer(id) })}
                    />
                  ) : focus.kind === 'developer' ? (
                    <DeveloperDetailsView
                      displayName={focus.label}
                      view={focusDeveloper.data}
                      loading={focusDeveloper.isLoading}
                      errorMessage={focusDeveloper.error ? dataErrorMessage(focusDeveloper.error) : null}
                      contextRepoId={null}
                      expandedHere={false}
                      onShowActivityHere={() => undefined}
                      onExploreFromDeveloper={() => undefined}
                      onOpenRepository={openRepository}
                    />
                  ) : null}
                </Card>
              </div>

              {focus.kind === 'repository' && (
                <Card>
                  <h3 className="mb-3 text-[11px] font-bold uppercase tracking-[0.12em] text-fg">
                    Engineering activity
                  </h3>
                  {needActivities ? (
                    <ActivityTabsView
                      activities={activities.data}
                      loading={activities.isLoading}
                      errorMessage={activities.error ? dataErrorMessage(activities.error) : null}
                      onReveal={reveal}
                    />
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => setNeedActivities(true)}>
                      Show commits, pull requests, reviews and Jira issues
                    </Button>
                  )}
                </Card>
              )}
            </>
          )}

          <RelationshipCoverageView
            rows={coverageRows}
            scope={focus?.kind === 'repository' ? `For ${focus.label}` : 'Tenant-wide'}
          />
        </>
      )}
    </div>
  );
}
