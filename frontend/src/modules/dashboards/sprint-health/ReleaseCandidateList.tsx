import { Badge, Card, TableBodyRow, TableHeadRow } from '../../../components/ui';
import { useSprintReleaseCandidates, type ReleaseCandidateView } from '../useInsights';
import { BarList, ErrorCard, LoadingCard } from '../widgets';
import { PlannedDateField } from './PlannedDateField';
import { releaseCandidatePill } from './release-pill';

/**
 * Sprint Health §Release candidates — one card per RC (Jira fix-version) in
 * this sprint's scope, with delivered stories, defect load, and the
 * human-recorded planned-release date (`sprint-health-detail.service.ts`,
 * `release-plan.controller.ts`).
 *
 * `projectKey` comes from the caller rather than the RC rows themselves —
 * `ReleaseCandidateView` carries no project, only `sprint` does (via
 * `SprintSummary.projectKey` on whichever query resolved the sprint).
 */
export function ReleaseCandidateList({
  sprint,
  projectKey,
  projects,
}: {
  sprint: string;
  projectKey: string;
  /** Projects selected on the board — narrows which stories count here. */
  projects: string[];
}) {
  const query = useSprintReleaseCandidates(sprint, projects);

  if (query.isLoading) return <LoadingCard label="Loading release candidates…" />;
  if (query.isError) return <ErrorCard error={query.error} />;

  const rows = query.data?.rows ?? [];

  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-sm text-fg-faint">
          No release candidates in scope for this sprint.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {rows.map((rc) => (
        <ReleaseCandidateCard
          key={rc.externalId ?? rc.name}
          rc={rc}
          sprint={sprint}
          projectKey={projectKey}
        />
      ))}
    </div>
  );
}

function ReleaseCandidateCard({
  rc,
  sprint,
  projectKey,
}: {
  rc: ReleaseCandidateView;
  sprint: string;
  projectKey: string;
}) {
  const pill = releaseCandidatePill(rc);

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-fg">{rc.name}</h3>
          {rc.externalId && (
            <p className="text-xs text-fg-subtle">{rc.externalId}</p>
          )}
        </div>
        <Badge tone={pill.tone}>{pill.text}</Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-subtle p-3">
          <span className="block text-xs text-fg-subtle">Planned release</span>
          <div className="mt-1">
            <PlannedDateField
              projectKey={projectKey}
              name={rc.name}
              sprint={sprint}
              plannedReleaseAt={rc.plannedReleaseAt}
            />
          </div>
        </div>
        <div className="rounded-lg border border-border bg-subtle p-3">
          <span className="block text-xs text-fg-subtle">Actual release</span>
          {/* actualReleaseAt is only meaningful once released — the backend
              already nulls it otherwise, so this never falls back to
              plannedReleaseAt to fill the gap. */}
          <span className="mt-1 block tabular-nums text-fg">
            {rc.released && rc.actualReleaseAt
              ? new Date(rc.actualReleaseAt).toLocaleDateString()
              : '—'}
          </span>
        </div>
        <div className="rounded-lg border border-border bg-subtle p-3">
          <span className="block text-xs text-fg-subtle">Stories delivered</span>
          <span className="mt-1 block tabular-nums text-fg">
            {rc.storiesDelivered} of {rc.storiesTotal}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <TableHeadRow>
              <th className="py-2 pr-4 font-medium">Story</th>
              <th className="py-2 font-medium">Status</th>
            </TableHeadRow>
          </thead>
          <tbody>
            {rc.stories.map((story) => (
              <TableBodyRow key={story.key}>
                <td className="py-2.5 pr-4">
                  <span className="font-medium text-fg-secondary">{story.key}</span>{' '}
                  <span className="text-fg-subtle">{story.title}</span>
                </td>
                <td className="py-2.5">
                  <Badge tone={story.delivered ? 'good' : 'neutral'}>
                    {story.delivered ? 'Delivered' : 'Not delivered'}
                  </Badge>
                </td>
              </TableBodyRow>
            ))}
            {rc.stories.length === 0 && (
              <TableBodyRow>
                <td colSpan={2} className="py-4 text-center text-sm text-fg-faint">
                  No stories in this RC's scope.
                </td>
              </TableBodyRow>
            )}
          </tbody>
        </table>
      </div>

      <div>
        <h4 className="mb-2 text-sm font-medium text-fg-muted">Bugs by priority</h4>
        <BarList
          rows={rc.bugsByPriority.map((b) => ({ label: b.priority, value: b.count }))}
          color="bg-danger"
        />
        {rc.bugSource === 'fix-version-fallback' && (
          <p className="mt-2 text-xs text-fg-faint">
            Counted by fix version — these stories carry no Affects Version, so
            this is "bugs to be fixed in {rc.name}", not "bugs found in it".
          </p>
        )}
      </div>

      <div className="mt-4 rounded-lg border border-dashed border-border p-4">
        <p className="text-sm font-medium text-fg-muted">Test execution</p>
        <p className="mt-1 text-xs text-fg-faint">
          Pass/fail/blocked results live in the team's test-management app,
          which SprintIQ does not collect yet. Not shown rather than estimated.
        </p>
      </div>
    </Card>
  );
}
