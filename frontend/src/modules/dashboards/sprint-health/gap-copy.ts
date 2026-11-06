import type { DataGapFinding, DataGapKind } from '../useInsights';

/**
 * What each Jira-vs-GitHub data gap means and the step that closes it
 * (backend `DataGapKind`). One registry, so the sprint-wide list and the
 * per-ticket labels can never describe the same gap two ways.
 *
 * `statement` takes the finding's counts and the project key (for an example
 * ticket key) and says what was found; `fix` is the flow that clears it.
 */
export const GAP_COPY: Record<
  DataGapKind,
  {
    /** Short label for a ticket row. */
    label: string;
    title: string;
    statement: (f: DataGapFinding, project: string) => string;
    fix: (project: string) => string;
  }
> = {
  'progress-not-marked': {
    label: 'Progress not marked',
    title: 'Progress not marked in Jira',
    statement: (f) =>
      `${tickets(f.count)} ${has(f.count)} commits or PRs on GitHub, but Jira still shows ${them(f.count)} as not started (To Do or Ready for Development).`,
    fix: () => 'Move them to In Progress — or further, if the code is already merged.',
  },
  'jira-not-updated': {
    label: 'Jira not updated',
    title: 'Jira not updated',
    statement: (f) =>
      `${tickets(f.count)} ${has(f.count)} every linked PR merged, but Jira still shows a development status.`,
    fix: () =>
      'Move them to the next stage (e.g. Ready for QA) once development is finished.',
  },
  'done-before-merge': {
    label: 'Done before merge',
    title: 'Marked done before the code merged',
    statement: (f) =>
      `${tickets(f.count)} ${is(f.count)} done in Jira while ${their(f.count)} PRs are still open on GitHub.`,
    fix: () => 'Merge the PR, or move the ticket back if work remains.',
  },
  'ticket-not-in-sprint': {
    label: 'Not in sprint',
    title: 'Work on tickets not in any sprint',
    statement: (f, p) =>
      `${commitsText(f.commits)} in this sprint name ${f.count} ${p} ${plural(f.count, 'ticket')} that ${is(f.count)} in no sprint (the backlog).`,
    fix: () =>
      'Add them to this sprint if this is the sprint’s work — until then the work is invisible to sprint tracking.',
  },
  'ticket-in-other-sprint': {
    label: 'In another sprint',
    title: 'Work on another sprint’s tickets',
    statement: (f, p) =>
      `${commitsText(f.commits)} in this sprint name ${f.count} ${p} ${plural(f.count, 'ticket')} planned in a different sprint.`,
    fix: () =>
      'Carry unfinished tickets over to this sprint, or check whether a later sprint’s work started early.',
  },
  'ticket-not-logged': {
    label: 'Not logged',
    title: 'Ticket not logged in Jira',
    statement: (f, p) =>
      `${commitsText(f.commits)} name ${f.count} ${p} ${plural(f.count, 'key')} that Jira has no ticket for.`,
    fix: () =>
      'Log the ticket in Jira, or correct the key in the branch or commit if it is a typo.',
  },
  'unassigned-with-code': {
    label: 'Not assigned',
    title: 'Ticket not assigned',
    statement: (f) =>
      `${tickets(f.count)} ${has(f.count)} code on GitHub but no assignee in Jira.`,
    fix: () => 'Assign them in Jira.',
  },
  'commits-not-tagged': {
    label: 'Commits not tagged',
    title: 'Commits not tagged with a Jira ticket',
    statement: (f) =>
      `${commitsText(f.commits)} in ${f.count} ${plural(f.count, 'repository', 'repositories')} this sprint’s work lives in name no Jira ticket.`,
    fix: (p) =>
      `Put the ticket key (e.g. ${p}-123) in the branch name or commit message — an untagged commit can’t be counted for any ticket or sprint.`,
  },
  'no-code-linked': {
    label: 'No code linked',
    title: 'No code linked yet',
    statement: (f) =>
      `${tickets(f.count)} ${is(f.count)} in development in Jira, but no commit, branch or PR names ${them(f.count)}.`,
    fix: () =>
      'If work has started, check the branch and commits carry the ticket key; otherwise nothing to do.',
  },
  'in-qa': {
    label: 'Awaiting QA',
    title: 'Code merged, waiting on QA',
    statement: (f) =>
      `${tickets(f.count)} ${has(f.count)} merged code and ${is(f.count)} in a QA, UAT or defect status in Jira.`,
    fix: () =>
      'The expected flow — no action. They count as done once Jira moves them to done.',
  },
};

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

function tickets(n: number): string {
  return `${n} ${plural(n, 'ticket')}`;
}

function commitsText(n: number | null): string {
  return n === null ? 'Commits' : `${n} ${plural(n, 'commit')}`;
}

function has(n: number): string {
  return n === 1 ? 'has' : 'have';
}

function is(n: number): string {
  return n === 1 ? 'is' : 'are';
}

function them(n: number): string {
  return n === 1 ? 'it' : 'them';
}

function their(n: number): string {
  return n === 1 ? 'its' : 'their';
}
