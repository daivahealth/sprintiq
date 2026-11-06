import type { DataGapFinding } from '../useInsights';
import { GAP_COPY } from './gap-copy';

/** The sprint's Jira-vs-GitHub data gaps, each with the step that fixes it. */
export function DataGapsList({
  gaps,
  project,
}: {
  gaps: DataGapFinding[];
  project: string;
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
      </p>
      {gaps.length === 0 ? (
        <p className="rounded-md border border-border bg-subtle p-3 text-sm text-fg-muted">
          Jira matches the GitHub work for every ticket in this sprint.
        </p>
      ) : (
        <ul className="space-y-2">
          {actions.length === 0 && (
            <li className="text-sm text-fg-muted">
              Nothing needs updating — only the notes below.
            </li>
          )}
          {gaps.map((g) => {
            const copy = GAP_COPY[g.kind];
            const action = g.severity === 'action';
            return (
              <li
                key={g.kind}
                className={
                  action
                    ? 'rounded-md border border-warning-border bg-warning-bg p-3'
                    : 'rounded-md border border-border bg-subtle p-3'
                }
              >
                <div
                  className={
                    action
                      ? 'text-sm font-medium text-warning-fg'
                      : 'text-sm font-medium text-fg-secondary'
                  }
                >
                  {copy.title}
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
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
