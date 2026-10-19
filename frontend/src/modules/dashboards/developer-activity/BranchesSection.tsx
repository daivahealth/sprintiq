import { Badge, Card, ProvenanceNote } from '../../../components/ui';
import { timeAgo } from '../../../lib/utils';

/** One branch from `developerActivity.branches` (branch tracking, 2026-10-19). */
export interface DeveloperBranchRow {
  repoFullName: string;
  branch: string;
  commits: number;
  locChanged: number;
  lastCommitAt: string;
  prStatus: 'merged' | 'open' | 'closed' | 'none';
}

const PR_LABEL: Record<DeveloperBranchRow['prStatus'], string> = {
  merged: 'PR merged',
  open: 'PR open',
  closed: 'PR closed',
  none: 'No PR',
};

const PR_TONE: Record<
  DeveloperBranchRow['prStatus'],
  'good' | 'warn' | 'neutral' | 'bad'
> = {
  merged: 'good',
  open: 'warn',
  closed: 'neutral',
  none: 'neutral',
};

/**
 * Every branch this person committed to in the window, merged or not, most
 * recently active first (DASHBOARDS.md §4.4.3). Answers "where has this work
 * been happening", including branches that never got a pull request — the
 * work the regular collector used to miss entirely.
 *
 * `branches` undefined means the API predates branch tracking: "not
 * available", never "no branches".
 */
export function BranchesSection({
  branches,
  branchesTotal,
}: {
  branches?: DeveloperBranchRow[];
  branchesTotal?: number;
}) {
  return (
    <Card className="space-y-3">
      <h4 className="text-sm font-medium text-fg-muted">Branches</h4>
      {branches === undefined ? (
        <p className="text-sm text-fg-faint">
          Branch tracking is not available on this server yet.
        </p>
      ) : branches.length === 0 ? (
        <p className="text-sm text-fg-faint">
          No branches recorded for this window. Branch names come from the
          GitHub audit-log route in ingest mode, so they appear only for work
          pushed while it runs.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-fg-subtle">
                <th className="py-2 pr-4 font-medium">Branch</th>
                <th className="py-2 pr-4 font-medium">Pull request</th>
                <th className="py-2 pr-4 font-medium">Commits</th>
                <th className="py-2 pr-4 font-medium">Changed lines</th>
                <th className="py-2 font-medium">Last commit</th>
              </tr>
            </thead>
            <tbody>
              {branches.map((b) => (
                <tr
                  key={`${b.repoFullName}@${b.branch}`}
                  className="border-b border-border-subtle"
                >
                  <td className="py-2 pr-4">
                    <div className="text-fg-secondary">{b.branch}</div>
                    <div className="text-xs text-fg-faint">
                      {b.repoFullName.replace(/^[^/]+\//, '')}
                    </div>
                  </td>
                  <td className="py-2 pr-4">
                    <Badge tone={PR_TONE[b.prStatus]}>{PR_LABEL[b.prStatus]}</Badge>
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{b.commits}</td>
                  <td className="py-2 pr-4 tabular-nums">
                    {b.locChanged.toLocaleString('en-US')}
                  </td>
                  <td className="py-2 text-xs text-fg-subtle">
                    {timeAgo(b.lastCommitAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {branches && branches.length > 0 && (
        <ProvenanceNote>
          Activity on branches, merged or not — where the work has been, not a
          ranking. A commit on several branches appears on each, so these rows
          do not add up to the totals above. Merge commits are not counted.
          {branchesTotal !== undefined && branchesTotal > branches.length
            ? ` Showing the ${branches.length} most recently active of ${branchesTotal}.`
            : ''}
        </ProvenanceNote>
      )}
    </Card>
  );
}
