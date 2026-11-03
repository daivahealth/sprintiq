import { useState, type ReactNode } from 'react';
import {
  Badge,
  SegmentedControl,
  Skeleton,
  TableBodyRow,
  TableHeadRow,
} from '../../components/ui';
import type { Attribution, Page, RepositoryActivitiesResponse } from './api';
import { formatCount, formatDay, shortSha } from './format';
import type { ActivityItemRef } from './graph-model';

export type ActivityTab = 'commits' | 'pullRequests' | 'reviews' | 'jiraIssues';

const TABS: { value: ActivityTab; label: string }[] = [
  { value: 'commits', label: 'Commits' },
  { value: 'pullRequests', label: 'Pull requests' },
  { value: 'reviews', label: 'Reviews' },
  { value: 'jiraIssues', label: 'Jira issues' },
];

/** Who did it, without ever naming a withheld identity. */
function Author({ item }: { item: Attribution }) {
  if (item.attribution === 'person') {
    return <span>{item.author.displayName}</span>;
  }
  return (
    <span className="text-fg-faint" title={item.attribution === 'withheld' ? 'Automation, anonymized or admin-excluded identity' : 'No known developer'}>
      {item.attribution === 'withheld' ? 'Withheld' : 'Unattributed'}
    </span>
  );
}

function RevealButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-xs text-brand hover:underline">
      Show in graph
    </button>
  );
}

function PageNote({ page, noun }: { page: Page<unknown>; noun: string }) {
  return (
    <p className="mb-2 text-xs text-fg-subtle">
      {page.items.length < page.total
        ? `The ${formatCount(page.items.length)} newest of ${formatCount(page.total)} ${noun} in the loaded window.`
        : `All ${formatCount(page.total)} ${noun} in the loaded window.`}
    </p>
  );
}

function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface">
          <TableHeadRow>{head}</TableHeadRow>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const th = 'py-2 pr-3';
const td = 'py-2 pr-3';

/** The selected repository's commits, PRs, reviews and Jira issues. */
export function ActivityTabsView({
  activities,
  loading,
  errorMessage,
  onReveal,
  initialTab = 'commits',
}: {
  activities: RepositoryActivitiesResponse | undefined;
  loading: boolean;
  errorMessage: string | null;
  onReveal: (item: ActivityItemRef) => void;
  initialTab?: ActivityTab;
}) {
  const [tab, setTab] = useState<ActivityTab>(initialTab);

  return (
    <section aria-label="Repository activity" className="space-y-3">
      <SegmentedControl
        value={tab}
        onChange={setTab}
        options={TABS.map((t) => ({
          value: t.value,
          label: activities ? `${t.label} (${formatCount(activities[t.value].total)})` : t.label,
        }))}
      />
      {errorMessage && <p className="text-sm text-danger-fg">{errorMessage}</p>}
      {loading && !activities && <Skeleton className="h-40 w-full" />}
      {activities && tab === 'commits' && (
        <>
          <PageNote page={activities.commits} noun="commits" />
          <Table
            head={
              <>
                <th className={th}>SHA</th>
                <th className={th}>Authored</th>
                <th className={th}>Author</th>
                <th className={th}>Repository</th>
                <th className="py-2" />
              </>
            }
          >
            {activities.commits.items.map((c) => (
              <TableBodyRow key={c.sha}>
                <td className={td}>
                  <code className="font-mono text-xs">{shortSha(c.sha)}</code>
                  {c.isMerge && <Badge className="ml-1.5">merge</Badge>}
                </td>
                <td className={td}>{formatDay(c.authoredAt)}</td>
                <td className={td}><Author item={c} /></td>
                <td className={`${td} text-xs text-fg-subtle`}>{activities.repository.fullName}</td>
                <td className="py-2 text-right">
                  <RevealButton onClick={() => onReveal({ kind: 'commit', sha: c.sha })} />
                </td>
              </TableBodyRow>
            ))}
          </Table>
        </>
      )}
      {activities && tab === 'pullRequests' && (
        <>
          <PageNote page={activities.pullRequests} noun="pull requests" />
          <Table
            head={
              <>
                <th className={th}>PR</th>
                <th className={th}>Title</th>
                <th className={th}>State</th>
                <th className={th}>Author</th>
                <th className={th}>Opened</th>
                <th className={th}>Merged</th>
                <th className="py-2" />
              </>
            }
          >
            {activities.pullRequests.items.map((p) => (
              <TableBodyRow key={p.number}>
                <td className={`${td} tabular-nums`}>#{p.number}</td>
                <td className={td}>
                  {p.title}
                  {p.jiraKeys.length > 0 && (
                    <span className="ml-1.5 text-xs text-fg-subtle">{p.jiraKeys.join(', ')}</span>
                  )}
                </td>
                <td className={td}><Badge>{p.state}</Badge></td>
                <td className={td}><Author item={p} /></td>
                <td className={td}>{formatDay(p.openedAt)}</td>
                <td className={td}>{formatDay(p.mergedAt)}</td>
                <td className="py-2 text-right">
                  <RevealButton onClick={() => onReveal({ kind: 'pull_request', number: p.number })} />
                </td>
              </TableBodyRow>
            ))}
          </Table>
        </>
      )}
      {activities && tab === 'reviews' && (
        <>
          <PageNote page={activities.reviews} noun="reviews" />
          <Table
            head={
              <>
                <th className={th}>Reviewer</th>
                <th className={th}>State</th>
                <th className={th}>Submitted</th>
                <th className={th}>Pull request</th>
                <th className="py-2" />
              </>
            }
          >
            {activities.reviews.items.map((r, index) => (
              <TableBodyRow key={`${r.prNumber}-${r.submittedAt}-${index}`}>
                <td className={td}><Author item={r} /></td>
                <td className={td}>{r.state.replace(/_/g, ' ')}</td>
                <td className={td}>{formatDay(r.submittedAt)}</td>
                <td className={`${td} tabular-nums`}>#{r.prNumber}</td>
                <td className="py-2 text-right">
                  <RevealButton onClick={() => onReveal({ kind: 'pull_request', number: r.prNumber })} />
                </td>
              </TableBodyRow>
            ))}
          </Table>
        </>
      )}
      {activities && tab === 'jiraIssues' && (
        <>
          <PageNote page={activities.jiraIssues} noun="Jira issues linked to PRs" />
          {activities.jiraIssues.total === 0 ? (
            <p className="text-sm text-fg-subtle">
              No pull request here carries a Jira key that matched a known issue. Commits are not
              linked to Jira directly.
            </p>
          ) : (
            <Table
              head={
                <>
                  <th className={th}>Issue</th>
                  <th className={th}>Title</th>
                  <th className={th}>Status</th>
                  <th className={th}>Type</th>
                  <th className={th}>Linked PRs (confidence · method)</th>
                  <th className="py-2" />
                </>
              }
            >
              {activities.jiraIssues.items.map((i) => (
                <TableBodyRow key={i.key}>
                  <td className={`${td} font-medium`}>{i.key}</td>
                  <td className={td}>{i.title}</td>
                  <td className={td}>{i.status}</td>
                  <td className={td}>{i.type}</td>
                  <td className={`${td} text-xs text-fg-subtle`}>
                    {i.pullRequests
                      .map(
                        (p) =>
                          `#${p.number}${
                            p.confidence !== undefined ? ` · ${Math.round(p.confidence * 100)}%` : ''
                          }${p.method ? ` · ${p.method}` : ''}`,
                      )
                      .join(', ')}
                  </td>
                  <td className="py-2 text-right">
                    <RevealButton onClick={() => onReveal({ kind: 'jira_issue', key: i.key })} />
                  </td>
                </TableBodyRow>
              ))}
            </Table>
          )}
        </>
      )}
    </section>
  );
}
