import { cn } from '../../../lib/utils';
import type { DataGapFinding, DataGapKind } from '../useInsights';
import { GAP_COPY } from './gap-copy';

/**
 * Per-ticket gaps can filter the ticket table to the tickets they describe.
 * The sprint-wide ones are read from commits on tickets OUTSIDE the sprint
 * (or on no ticket), so there is no row in the table to filter to.
 */
const SPRINT_WIDE: DataGapKind[] = [
  'ticket-not-in-sprint',
  'ticket-in-other-sprint',
  'ticket-not-logged',
  'commits-not-tagged',
];

/** The sprint's Jira-vs-GitHub data gaps, each with the step that fixes it. */
export function DataGapsList({
  gaps,
  project,
  active,
  onSelect,
}: {
  gaps: DataGapFinding[];
  project: string;
  /** The gap the ticket table is currently filtered to, if any. */
  active?: DataGapKind;
  onSelect?: (kind: DataGapKind) => void;
}) {
  const actions = gaps.filter((g) => g.severity === 'action');
  return (
    <div>
      <h4 className="mb-1 text-sm font-medium text-fg-muted">
        Jira vs GitHub — where Jira is behind
      </h4>
      <p className="mb-2 text-xs text-fg-faint">
        Compared ticket by ticket against the commits and PRs that name them. GitHub is
        taken as what happened in code; Jira as where the ticket stands.
        {onSelect && ' Click a ticket finding to list its tickets below.'}
      </p>
      {gaps.length === 0 ? (
        <p className="metal-surface rounded-md p-3 text-sm text-fg-muted">
          Jira matches the GitHub work for every ticket in this sprint.
        </p>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {actions.length === 0 && (
            <li className="text-sm text-fg-muted md:col-span-2">
              Nothing needs updating — only the notes below.
            </li>
          )}
          {gaps.map((g) => {
            const copy = GAP_COPY[g.kind];
            const action = g.severity === 'action';
            const selectable = Boolean(onSelect) && !SPRINT_WIDE.includes(g.kind);
            const body = (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={
                      action
                        ? 'text-sm font-medium text-warning-fg'
                        : 'text-sm font-medium text-fg-secondary'
                    }
                  >
                    {copy.title}
                  </span>
                  <span className="shrink-0 text-lg font-bold tabular-nums tracking-[-0.03em] text-fg">
                    {g.count}
                  </span>
                </div>
                <p className="mt-0.5 text-sm text-fg-muted">
                  {copy.statement(g, project)}
                </p>
                <p className="mt-0.5 text-xs text-fg-subtle">
                  <span className="font-medium">{action ? 'Fix: ' : 'Note: '}</span>
                  {copy.fix(project)}
                </p>
                {g.sample.length > 0 && (
                  <p className="mt-1 text-[11px] tabular-nums text-fg-faint">
                    {g.sample.join(', ')}
                    {g.count > g.sample.length &&
                      ` and ${g.count - g.sample.length} more`}
                  </p>
                )}
              </>
            );
            const shell = cn(
              'metal-surface metal-sheen block h-full w-full rounded-md p-3 text-left',
              // A finding to act on keeps an amber edge so it never reads as a note.
              action && 'border-l-4 border-l-warning',
              selectable &&
                'cursor-pointer transition hover:border-brand/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
              active === g.kind && 'border-brand ring-2 ring-brand/25',
            );
            return (
              <li key={g.kind}>
                {selectable ? (
                  <button
                    type="button"
                    className={shell}
                    aria-pressed={active === g.kind}
                    onClick={() => onSelect!(g.kind)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={shell}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
