import { useCallback, useEffect, useMemo } from 'react';
import { useScope } from '../../lib/scope';
import type { SprintHealthView, SprintSummary } from './useInsights';

/**
 * Sprint Health's sprint selection, shared by its subpages (the Board and
 * Efforts) — moved out of boards.tsx on 2026-11-23 so both can use it, and so
 * that file keeps exporting components only (fast refresh).
 */

/** "NHC · Sprint-26-11" — the scoped projects, falling back to the sprint's own. */
export function sprintLabel(view: { sprint: SprintSummary; projects?: string[] }) {
  const projects =
    view.projects && view.projects.length > 0
      ? view.projects.join(', ')
      : view.sprint.projectKey;
  return `${projects} · ${view.sprint.name}`;
}

/**
 * Sprint Health's picker: the selected projects' ongoing sprints only, one
 * option per sprint, labelled with the selected projects that run it.
 *
 * Not `useSprintSelection`: that lists the catalog's active AND closed sprints
 * labelled by `sprint.projectKey`, so ACT's picker offered 59 sprints, 30 of
 * them under another project's name ("AS2 · Sprint-26-10" — ACT's own October
 * sprint, filed under AS2 because Jira saw AS2 in it first). A sprint in the
 * URL that is not ongoing for these projects — a stale link, a hand-edited
 * URL — is replaced by the ongoing one rather than shown.
 */
export function useOngoingSprintSelection(rows: SprintHealthView[] | undefined) {
  const { scope, setScope } = useScope();
  const options = useMemo(() => {
    const bySprint = new Map<string, { sprint: SprintSummary; projects: string[] }>();
    for (const row of rows ?? []) {
      const entry = bySprint.get(row.sprint.externalId) ?? {
        sprint: row.sprint,
        projects: [],
      };
      entry.projects.push(...(row.projects ?? []));
      bySprint.set(row.sprint.externalId, entry);
    }
    return [...bySprint.values()].map((e) => ({
      ...e,
      projects: [...new Set(e.projects)].sort(),
    }));
  }, [rows]);
  const setSprint = useCallback(
    (externalId: string) => setScope({ sprint: externalId }),
    [setScope],
  );

  const sprint = scope.sprint;
  useEffect(() => {
    if (rows === undefined) return;
    if (!options.some((o) => o.sprint.externalId === sprint)) {
      const next = options[0]?.sprint.externalId ?? null;
      if (next !== sprint) setScope({ sprint: next });
    }
  }, [rows, options, sprint, setScope]);

  const valid = options.some((o) => o.sprint.externalId === sprint);
  return { options, sprint: valid ? sprint : null, setSprint };
}
