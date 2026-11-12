import type { CommitActivityView, SprintCommitLinkage } from '../useInsights';
import { Tip } from './metal';
import { SectionTitle, Tile as Stat } from './parts';

/**
 * Sprint Health §Commit activity — five tiles over the sprint's own window
 * and the GitHub work linked to its tickets
 * (`sprint-health-detail.service.ts#commitActivity`).
 *
 * Two nulls get the same discipline as everywhere else on these boards:
 * `avgHoursToFirstReview === null` renders `—`, never `0h` — a sprint where
 * nothing has been reviewed yet has no average, and `0h` would claim the
 * opposite ("reviewed instantly"). `commitsPerDay`/`reviewedPct` follow the
 * same rule inside `Stat`'s optional `hint`.
 */
export function CommitActivityTiles({ data }: { data: CommitActivityView }) {
  return (
    <section>
      <SectionTitle title="Code commit activity" echo="project level" />
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-5">
        <Stat
          label="Developers who committed"
          value={data.committers}
          hint={`of ${data.assignees} assigned to sprint`}
        />
        <Stat
          label="Commits this sprint"
          value={data.commits}
          hint={[
            data.commitsPerDay === null ? null : `${data.commitsPerDay}/day avg`,
            // Merges are out of the count (METRICS.md §0); say how many.
            data.mergeCommitsExcluded ? `${data.mergeCommitsExcluded} merges not counted` : null,
          ]
            .filter(Boolean)
            .join(' · ') || undefined}
        />
        <Stat label="PRs raised" value={data.prsRaised}
          hint={`${data.prsOpen} open, ${data.prsMerged} merged`} />
        <Stat label="PRs reviewed" value={data.prsReviewed}
          hint={data.reviewedPct === null ? undefined : `${data.reviewedPct}% of raised PRs`} />
        <Stat
          label="Avg time to first review"
          value={data.avgHoursToFirstReview === null ? '—' : `${data.avgHoursToFirstReview}h`}
          hint={data.prsWaitingOver24h > 0 ? `${data.prsWaitingOver24h} PRs waiting >24h` : undefined}
          // Amber only when something is actually waiting — the average
          // alone doesn't say whether anyone is blocked right now.
          valueClassName={data.prsWaitingOver24h > 0 ? 'text-warning-fg' : undefined}
        />
      </div>

      {/* The scope judgement behind every number above — invisible otherwise. */}
      {data.linkage && <LinkageNote linkage={data.linkage} />}
    </section>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Git has no sprint field, so the tiles count only commits that name one of
 * the sprint's tickets — and say how much of the window that leaves out, so a
 * low count reads as "unlinked work" rather than "no work".
 *
 * Kept to one quiet line (the mockup has none; CLAUDE.md requires linkage
 * coverage to be surfaced): the coverage figure stays visible, the breakdown
 * of what was left out sits in the tooltip, and the truncation warning — the
 * one fact that changes how to read the tiles — is never hidden.
 */
function LinkageNote({ linkage }: { linkage: SprintCommitLinkage }) {
  const detail = [
    linkage.linkedViaBranchOnly > 0
      ? `${linkage.linkedViaBranchOnly} linked through the branch name only.`
      : null,
    'PRs and reviews are the ones linked to these tickets.',
    `In the same dates, ${plural(linkage.otherTicketCommits, 'commit')} name other tickets in this project, and ${linkage.noTicketCommits} across every repository name no ticket Jira knows, so they can't be placed in any project.`,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <p className="mt-2 text-xs text-fg-faint">
      <Tip content={detail}>
        <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-2">
          Linked to this sprint&apos;s {plural(linkage.sprintTickets, 'ticket')}:{' '}
          {plural(linkage.linkedCommits, 'commit')}
          {linkage.reposTouched.length > 0 &&
            ` across ${plural(linkage.reposTouched.length, 'repo')}`}
        </span>
      </Tip>
      {linkage.truncated &&
        ' — the commit read hit its row limit, so these counts are a floor'}
      .
    </p>
  );
}
