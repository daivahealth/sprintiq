import { Stat } from '../widgets';
import type { CommitActivityView } from '../useInsights';

/**
 * Sprint Health §Commit activity — five tiles over the sprint's own window
 * and its own repos (`sprint-health-detail.service.ts#commitActivity`).
 *
 * Two nulls get the same discipline as everywhere else on these boards:
 * `avgHoursToFirstReview === null` renders `—`, never `0h` — a sprint where
 * nothing has been reviewed yet has no average, and `0h` would claim the
 * opposite ("reviewed instantly"). `commitsPerDay`/`reviewedPct` follow the
 * same rule inside `Stat`'s optional `hint`.
 */
export function CommitActivityTiles({ data }: { data: CommitActivityView }) {
  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat
          label="Developers who committed"
          value={data.committers}
          hint={`of ${data.assignees} assigned to sprint`}
        />
        <Stat
          label="Commits this sprint"
          value={data.commits}
          hint={data.commitsPerDay === null ? undefined : `${data.commitsPerDay}/day avg`}
        />
        <Stat label="PRs raised" value={data.prsRaised}
          hint={`${data.prsOpen} open, ${data.prsMerged} merged`} />
        <Stat label="PRs reviewed" value={data.prsReviewed}
          hint={data.reviewedPct === null ? undefined : `${data.reviewedPct}% of raised`} />
        <Stat
          label="Avg time to first review"
          value={data.avgHoursToFirstReview === null ? '—' : `${data.avgHoursToFirstReview}h`}
          hint={data.prsWaitingOver24h > 0 ? `${data.prsWaitingOver24h} PRs waiting >24h` : undefined}
        />
      </div>

      {/* The scope judgement behind every number above — invisible otherwise. */}
      <p className="mt-2 text-xs text-fg-faint">
        Commits are counted by date across {data.repos.length} repo
        {data.repos.length === 1 ? '' : 's'} linked to this project — Git has no
        sprint field, so a repo that has never carried a linked PR contributes
        nothing here.
      </p>
    </div>
  );
}
