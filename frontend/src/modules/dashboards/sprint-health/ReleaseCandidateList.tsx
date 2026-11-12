import type { ReactNode } from 'react';
import { Badge, Card } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { useSprintReleaseCandidates, type ReleaseCandidateView } from '../useInsights';
import { ErrorCard, LoadingCard } from '../widgets';
import { PlannedDateField } from './PlannedDateField';
import { SectionTitle } from './parts';
import { PRIORITY_FILL, PRIORITY_TEXT, priorityBand } from './presentation';
import { releaseCandidatePill } from './release-pill';

/**
 * Sprint Health §RC-wise scope & quality — one card per RC (Jira fix-version)
 * in this sprint's scope, with delivered stories, defect load, and the
 * human-recorded planned-release date (`sprint-health-detail.service.ts`,
 * `release-plan.controller.ts`).
 *
 * The backend orders RCs by release date, undated last, so the final card is
 * the latest cut and is badged as such.
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
  const rows = query.data?.rows ?? [];

  return (
    <section>
      <SectionTitle
        title="RC-wise scope & quality"
        echo="every RC in this sprint — what's in it, when it shipped, the bugs logged against it"
      />

      {query.isLoading && <LoadingCard label="Loading release candidates…" />}
      {query.isError && <ErrorCard error={query.error} />}

      {query.data && rows.length === 0 && (
        <Card>
          <p className="text-sm text-fg-faint">
            No release candidates in scope for this sprint.
          </p>
        </Card>
      )}

      {rows.length > 0 && (
        <div className="space-y-4">
          {rows.map((rc, i) => (
            <ReleaseCandidateCard
              key={rc.externalId ?? rc.name}
              rc={rc}
              latest={rows.length > 1 && i === rows.length - 1}
              sprint={sprint}
              projectKey={projectKey}
            />
          ))}
          {rows.length > 1 && (
            <p className="text-xs text-fg-faint">
              Stories delivered across {rows.map((r) => r.name).join(' → ')}:{' '}
              {rows.map((r) => `${r.storiesDelivered}/${r.storiesTotal}`).join(' → ')}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function BlockTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2">
      <h4 className="text-xs font-bold uppercase tracking-[0.04em] text-fg-subtle">
        {children}
      </h4>
      {aside && <span className="text-xs text-fg-subtle">{aside}</span>}
    </div>
  );
}

function DateStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-border-subtle bg-subtle px-3 py-2">
      <span className="mb-0.5 block text-[11px] text-fg-faint">{label}</span>
      <div className="text-[15px] font-bold tabular-nums text-fg">{children}</div>
    </div>
  );
}

function ReleaseCandidateCard({
  rc,
  latest,
  sprint,
  projectKey,
}: {
  rc: ReleaseCandidateView;
  latest: boolean;
  sprint: string;
  projectKey: string;
}) {
  const pill = releaseCandidatePill(rc);

  return (
    <Card className={cn('space-y-5', latest && 'border-success')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-fg">
            {rc.name}
            {latest && (
              <Badge tone="good" className="ml-2 align-middle">
                latest
              </Badge>
            )}
          </h3>
          {rc.externalId && (
            <p className="text-xs text-fg-faint">{rc.externalId}</p>
          )}
        </div>
        <Badge tone={pill.tone}>{pill.text}</Badge>
      </div>

      <div>
        <BlockTitle>Scope &amp; release dates</BlockTitle>
        <div className="mb-3 grid gap-2.5 sm:grid-cols-3">
          <DateStat label="Planned release">
            <PlannedDateField
              projectKey={projectKey}
              name={rc.name}
              sprint={sprint}
              plannedReleaseAt={rc.plannedReleaseAt}
            />
          </DateStat>
          <DateStat label="Actual release">
            {/* actualReleaseAt is only meaningful once released — the backend
                already nulls it otherwise, so this never falls back to
                plannedReleaseAt to fill the gap. */}
            {rc.released && rc.actualReleaseAt
              ? new Date(rc.actualReleaseAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })
              : '—'}
          </DateStat>
          <DateStat label="Stories delivered">
            {rc.storiesDelivered} / {rc.storiesTotal}
          </DateStat>
        </div>

        {rc.stories.length === 0 ? (
          <p className="py-2 text-sm text-fg-faint">No stories in this RC&apos;s scope.</p>
        ) : (
          <table className="w-full text-[13px]">
            <tbody>
              {rc.stories.map((story) => (
                <tr key={story.key} className="border-t border-border-subtle">
                  <td className="w-px whitespace-nowrap py-1.5 pr-3 font-semibold text-brand">
                    {story.key}
                  </td>
                  <td className="py-1.5 pr-3 text-fg-subtle">{story.title}</td>
                  <td className="w-px whitespace-nowrap py-1.5 text-right">
                    {story.delivered ? (
                      <Badge tone="good">Delivered</Badge>
                    ) : (
                      // After release an undelivered story missed the cut;
                      // before it, it's still pending.
                      <Badge tone="warn">{rc.released ? 'Not delivered' : 'Pending'}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="border-t border-border-subtle pt-4">
        <BlockTitle aside="not collected">Test execution summary</BlockTitle>
        <div className="rounded-md border border-dashed border-border p-3">
          <p className="text-xs text-fg-faint">
            Pass / fail / blocked / not-run results live in the team&apos;s
            test-management app, which SprintIQ does not collect yet. Not shown
            rather than estimated.
          </p>
        </div>

        <div className="mt-4 border-t border-border-subtle pt-3">
          <p className="mb-2 text-xs text-fg-faint">Bugs logged against this RC</p>
          {rc.bugsByPriority.length === 0 ? (
            <p className="text-sm text-fg-faint">None logged.</p>
          ) : (
            rc.bugsByPriority.map((b) => {
              const band = priorityBand(b.priority);
              return (
                <div
                  key={b.priority}
                  className="flex items-center justify-between py-1 text-sm"
                >
                  <span className={cn('flex items-center gap-2 font-semibold', PRIORITY_TEXT[band])}>
                    <span
                      aria-hidden
                      className={cn('h-2 w-2 rounded-full', PRIORITY_FILL[band])}
                    />
                    {b.priority}
                  </span>
                  <span className="font-bold tabular-nums text-fg">{b.count}</span>
                </div>
              );
            })
          )}
          {rc.bugSource === 'fix-version-fallback' && (
            <p className="mt-2 text-xs text-fg-faint">
              Counted by fix version — these stories carry no Affects Version,
              so this is &quot;bugs to be fixed in {rc.name}&quot;, not &quot;bugs
              found in it&quot;.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
