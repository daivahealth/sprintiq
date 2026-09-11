import { Card } from '../../../components/ui';
import { BarList, Stat } from '../widgets';
import type { QualityCheckView } from '../useInsights';

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

  return (
    <Card className="space-y-4">
      <h3 className="font-semibold text-fg">Quality check</h3>

      <div className="grid gap-4 sm:grid-cols-2">
        <Stat
          label="Stories released"
          value={data.storiesReleased}
          hint="reached done, in this sprint's window"
        />

        <div className="rounded-lg border border-border bg-subtle p-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-fg-subtle">Rolled back</span>
            <span className="text-xs tabular-nums text-fg-muted">
              {rolledBackPct === null
                ? `${data.rolledBack} rolled back`
                : `${data.rolledBack} rolled back (${rolledBackPct}%)`}
            </span>
          </div>
          <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
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
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-sm font-medium text-fg-muted">Bugs by priority</h4>
        <BarList
          rows={data.bugsByPriority.map((b) => ({ label: b.priority, value: b.count }))}
          color="bg-danger"
        />
      </div>

      <p className="text-xs text-fg-faint">
        {data.bugsPerStoryReleased === null
          ? `No stories released yet — bug ratio not computable (${data.bugsLogged} bugs logged).`
          : `${data.bugsPerStoryReleased} bugs per story released — ${data.bugsLogged} bugs logged in total.`}
      </p>
    </Card>
  );
}
