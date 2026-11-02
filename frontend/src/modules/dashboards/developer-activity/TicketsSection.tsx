import { Fragment, useState } from 'react';
import { ChevronRight, ExternalLink } from 'lucide-react';
import {
  Badge,
  Card,
  ProvenanceNote,
  TableBodyRow,
  TableHeadRow,
} from '../../../components/ui';
import { cn, timeAgo } from '../../../lib/utils';
import { TypeBadge } from '../widgets';

type LinkSource = 'branch' | 'message';

/** One of the developer's commits on a ticket, as the row's drill-down lists it. */
export interface DeveloperTicketCommit {
  /** Full SHA — the GitHub link needs it. */
  sha: string;
  repo: string;
  message: string;
  committedAt: string;
  additions: number;
  deletions: number;
  linkedVia: LinkSource[];
}

/** One Jira item from `developerActivity.tickets` (2026-11-02). */
export interface DeveloperTicketRow {
  key: string;
  projectKey: string;
  type: string;
  /** As Jira states it now — the range windows the commits, not the status. */
  status: string;
  title: string;
  commits: number;
  lastCommitAt: string;
  /** Where their commits named it: the commit message, a branch name, or both. */
  linkedVia: LinkSource[];
  /** Those commits, newest first, capped; `commits` is the full count. Optional: an older API omits it. */
  commitList?: DeveloperTicketCommit[];
}

/** The section's anchor, so the header's project badges can scroll to it. */
export const TICKETS_SECTION_ID = 'developer-tickets';

const LINK_LABEL: Record<LinkSource, string> = {
  message: 'commit message',
  branch: 'branch name',
};

const COLUMNS = 7;

/**
 * The Jira items this person's commits in the range reference, most recently
 * committed first (DASHBOARDS.md §4.4.3).
 *
 * Only tickets their own commits point at — a key in the commit message, or in
 * the branch the commit was on. Tickets merely assigned to them are not here:
 * assignment says what the plan expects, this says what the work touched.
 *
 * A row opens in place to list those commits, each linked to GitHub, so the
 * person and the range stay on screen while the evidence is read. `project`
 * narrows the table to one project, set from the header's project badges.
 *
 * `tickets` undefined means the API predates the section: render nothing
 * rather than claim "no tickets".
 */
export function TicketsSection({
  tickets,
  ticketsTotal,
  commitsWithoutTicket,
  commits,
  project,
  onClearProject,
}: {
  tickets?: DeveloperTicketRow[];
  ticketsTotal?: number;
  commitsWithoutTicket?: number;
  /** Authored commits in the window — the denominator for the coverage note. */
  commits: number;
  project: string | null;
  onClearProject: () => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  if (tickets === undefined) {
    return null;
  }

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const total = ticketsTotal ?? tickets.length;
  const capped = total > tickets.length;
  const rows = project
    ? tickets.filter((t) => t.projectKey === project)
    : tickets;

  return (
    <Card id={TICKETS_SECTION_ID} className="scroll-mt-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium text-fg-muted">
            Tickets committed against ·{' '}
            {project ? `${rows.length} in ${project}` : total}
          </h4>
          <p className="text-xs text-fg-subtle">
            Jira items named in this developer&apos;s commit messages or branch
            names in this range. Status is as it stands in Jira now. Open a row
            to see its commits.
          </p>
        </div>
        {project && (
          <button
            type="button"
            onClick={onClearProject}
            className="text-xs font-medium text-fg-muted underline-offset-2 hover:text-fg hover:underline"
          >
            Show all projects
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-fg-faint">
          {project
            ? `None of the tickets listed here are in ${project}.`
            : commits === 0
              ? 'No commits in this range.'
              : 'None of this developer’s commits in this range name a known Jira item.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <TableHeadRow>
                <th className="py-2 pr-4 font-medium">Item</th>
                <th className="py-2 pr-4 font-medium">Type</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Title</th>
                <th className="py-2 pr-4 font-medium">Commits</th>
                <th className="py-2 pr-4 font-medium">Linked via</th>
                <th className="py-2 font-medium">Last commit</th>
              </TableHeadRow>
            </thead>
            <tbody>
              {rows.map((t) => {
                const expandable = (t.commitList?.length ?? 0) > 0;
                const isOpen = expandable && open.has(t.key);
                const panelId = `ticket-commits-${t.key}`;
                return (
                  <Fragment key={t.key}>
                    <TableBodyRow
                      className={cn(expandable && 'cursor-pointer', isOpen && 'bg-subtle')}
                      onClick={expandable ? () => toggle(t.key) : undefined}
                    >
                      <td className="py-2.5 pr-4 font-medium text-fg-secondary">
                        {expandable ? (
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            aria-controls={panelId}
                            onClick={(e) => {
                              // The row toggles too; don't toggle twice.
                              e.stopPropagation();
                              toggle(t.key);
                            }}
                            className="inline-flex items-center gap-1 rounded-sm hover:text-fg"
                          >
                            <ChevronRight
                              aria-hidden
                              className={cn(
                                'h-3.5 w-3.5 shrink-0 text-fg-faint motion-safe:transition-transform',
                                isOpen && 'rotate-90',
                              )}
                            />
                            {t.key}
                          </button>
                        ) : (
                          t.key
                        )}
                      </td>
                      <td className="py-2.5 pr-4">
                        <TypeBadge type={t.type} />
                      </td>
                      <td className="py-2.5 pr-4">
                        <Badge tone="neutral">{t.status}</Badge>
                      </td>
                      <td
                        className="max-w-md truncate py-2.5 pr-4 text-fg-secondary"
                        title={t.title}
                      >
                        {t.title}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">{t.commits}</td>
                      <td className="py-2.5 pr-4 text-xs text-fg-subtle">
                        {t.linkedVia.map((v) => LINK_LABEL[v]).join(', ')}
                      </td>
                      <td className="py-2.5 text-xs text-fg-subtle">
                        {timeAgo(t.lastCommitAt)}
                      </td>
                    </TableBodyRow>
                    {isOpen && t.commitList && (
                      <tr id={panelId} className="border-b border-border-subtle bg-subtle">
                        <td colSpan={COLUMNS} className="px-2 pb-3 pt-1">
                          <TicketCommits ticket={t} commits={t.commitList} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(tickets.length > 0 || (commitsWithoutTicket ?? 0) > 0) && (
        <ProvenanceNote>
          Where the work went, not a ranking. A commit naming two tickets counts
          on both. Merge commits are not counted.
          {capped
            ? ` Showing the ${tickets.length} most recently committed of ${total}${project ? ', so a filtered view may leave some of this project out' : ''}.`
            : ''}
          {(commitsWithoutTicket ?? 0) > 0
            ? ` ${commitsWithoutTicket} of ${commits} commits in this range name no known Jira item, so they appear on no ticket.`
            : ''}
        </ProvenanceNote>
      )}
    </Card>
  );
}

/** One ticket's commits by this developer in the range, newest first. */
function TicketCommits({
  ticket,
  commits,
}: {
  ticket: DeveloperTicketRow;
  commits: DeveloperTicketCommit[];
}) {
  return (
    <div className="space-y-1">
      <ul className="divide-y divide-border-subtle">
        {commits.map((c) => (
          <li
            key={`${c.repo}@${c.sha}`}
            className="flex items-center gap-3 py-1.5 text-sm"
          >
            <a
              href={`https://github.com/${c.repo}/commit/${c.sha}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open this commit on GitHub"
              className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-fg-subtle hover:text-fg"
            >
              {c.sha.slice(0, 7)}
              <ExternalLink aria-hidden className="h-3 w-3" />
            </a>
            <span className="w-36 shrink-0 truncate text-xs text-fg-subtle" title={c.repo}>
              {c.repo.replace(/^[^/]+\//, '')}
            </span>
            <span className="min-w-0 flex-1 truncate text-fg-secondary" title={c.message}>
              {c.message}
            </span>
            <span className="shrink-0 tabular-nums text-xs">
              <span className="text-success-fg">+{c.additions}</span>{' '}
              <span className="text-danger-fg">−{c.deletions}</span>
            </span>
            <span className="hidden w-28 shrink-0 text-xs text-fg-faint sm:inline">
              via {c.linkedVia.map((v) => LINK_LABEL[v]).join(', ')}
            </span>
            <span className="w-20 shrink-0 text-right text-xs text-fg-faint">
              {timeAgo(c.committedAt)}
            </span>
          </li>
        ))}
      </ul>
      {ticket.commits > commits.length && (
        <p className="text-xs text-fg-faint">
          Showing the {commits.length} most recent of {ticket.commits} commits
          on {ticket.key}.
        </p>
      )}
    </div>
  );
}
