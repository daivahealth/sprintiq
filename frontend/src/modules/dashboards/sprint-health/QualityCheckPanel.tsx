import { cn } from '../../../lib/utils';
import type { QualityCheckView } from '../useInsights';
import { SectionTitle, Panel } from './parts';
import { PRIORITY_FILL, PRIORITY_TEXT, priorityBand } from './presentation';

/**
 * Sprint Health §Quality check — releases, rollbacks and bug load
 * (`sprint-health-detail.service.ts#qualityCheck`).
 *
 * `rolledBackPct` is `null` when nothing entered `done` in this sprint's
 * window yet (not merely when nothing has been RELEASED — a rollback can
 * only happen to an item that reached `done`, so that's the population its
 * percentage is read against); `bugsPerStoryReleased` is separately `null`
 * when nothing has been released yet. Both render a sentence rather than a
 * `0.0` — a fraction over a zero denominator is not "zero", it's "not
 * computable". The rollback COUNT itself is always shown, independent of
 * whether anything was released — three rollbacks in a sprint that shipped
 * nothing is still a signal worth seeing, not something to hide.
 */
export function QualityCheckPanel({ data }: { data: QualityCheckView }) {
  // Defensive clamp: `rolledBack` and the window's done-entries are read from
  // independent scans of the same transition history, so a data anomaly
  // could in principle still push the raw percentage outside [0, 100] — and
  // an unclamped value would render a negative-width bar next to an
  // over-wide one.
  const rolledBackPct =
    data.rolledBackPct === null
      ? null
      : Math.min(100, Math.max(0, data.rolledBackPct));

  const maxBugs = Math.max(1, ...data.bugsByPriority.map((b) => b.count));
  const severeBugs = data.bugsByPriority
    .filter((b) => priorityBand(b.priority) === 'p1')
    .reduce((sum, b) => sum + b.count, 0);

  return (
    <section>
      <SectionTitle
        title="Quality check"
        echo="stories released vs. defects logged this sprint"
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_1.3fr]">
        <Panel>
          <div className="text-3xl font-bold tabular-nums text-fg">
            {data.storiesReleased}
          </div>
          <div className="text-sm text-fg-subtle">Stories released this sprint</div>

          <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
            {rolledBackPct !== null && (
              <>
                <div
                  className="h-full bg-success"
                  style={{ width: `${100 - rolledBackPct}%` }}
                />
                <div
                  className="h-full bg-danger"
                  style={{ width: `${rolledBackPct}%` }}
                />
              </>
            )}
          </div>
          {/* The percentage is read against items that reached done in the
              window (the only population a rollback can come from) — said in
              the hover title rather than on the line, as in the mockup. */}
          <p
            className="mt-1.5 text-xs text-fg-subtle"
            title="Released = reached done inside this sprint's window. The percentage is of the items that reached done."
          >
            {data.storiesReleased} released · {data.rolledBack} rolled back /
            reopened
            {rolledBackPct !== null && ` (${rolledBackPct}%)`}
          </p>
        </Panel>

        <Panel>
          <h4 className="mb-3 text-[12.5px] font-semibold text-fg-muted">
            Bugs logged, by priority
          </h4>
          {data.bugsByPriority.length === 0 ? (
            <p className="py-2 text-sm text-fg-faint">No bugs logged in scope.</p>
          ) : (
            <div className="space-y-2.5">
              {data.bugsByPriority.map((b) => {
                const band = priorityBand(b.priority);
                return (
                  <div
                    key={b.priority}
                    className="grid grid-cols-[5.5rem_1fr_3rem] items-center gap-3 text-sm"
                  >
                    <span className={cn('truncate font-semibold', PRIORITY_TEXT[band])}>
                      {b.priority}
                    </span>
                    <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn('h-full rounded-full', PRIORITY_FILL[band])}
                        style={{ width: `${(b.count / maxBugs) * 100}%` }}
                      />
                    </div>
                    <span className="text-right tabular-nums text-fg-subtle">
                      {b.count}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <p
            className={cn(
              'mt-3 text-xs',
              severeBugs > 0 ? 'text-warning-fg' : 'text-fg-faint',
            )}
          >
            {data.bugsPerStoryReleased === null
              ? `No stories released yet — bug ratio not computable (${data.bugsLogged} bugs logged)`
              : `${data.bugsPerStoryReleased} bugs logged per story released`}
            {severeBugs > 0
              ? ` — ${severeBugs} Highest-priority ${severeBugs === 1 ? 'bug needs' : 'bugs need'} triage before next release.`
              : '.'}
          </p>
        </Panel>
      </div>
    </section>
  );
}
