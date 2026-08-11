/**
 * Canonical domain-event payload contracts (the normalized shape every source
 * collector produces for a given event family). Neutral home so both collectors
 * (producers) and domain contexts (consumers) share one definition.
 */

export interface CodePullRequestPayload {
  repoFullName: string; // e.g. acme/payments
  externalNumber: string;
  title: string;
  branch: string;
  baseBranch?: string;
  state: 'open' | 'merged' | 'closed';
  authorLogin?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  commitMessages?: string[];
  openedAt?: string;
  firstReviewAt?: string;
  approvedAt?: string;
  mergedAt?: string;
}

/**
 * One commit (from a push webhook or poller). NOTE: GitHub push webhooks do not
 * carry per-commit LOC — additions/deletions arrive via the poller's commit
 * detail fetch; webhook-only commits carry filesChanged and 0/0 LOC until then.
 */
export interface CodeCommitPayload {
  repoFullName: string;
  sha: string;
  message: string;
  authorLogin?: string;
  authorName?: string;
  authorEmail?: string;
  authoredAt: string;
  /**
   * When the commit was actually written to the repo — differs from
   * `authoredAt` on a rebase/cherry-pick/amend. Poller: GitHub's commit list
   * endpoint's `commit.committer.date`. Webhook: GitHub's push payload only
   * carries one timestamp per commit, so it's set equal to `authoredAt`.
   */
  committedAt?: string;
  additions?: number;
  deletions?: number;
  filesChanged?: number;
}

/** Sprint attribution embedded in a work-item event (upserted as a Sprint row). */
export interface PlanningSprintRef {
  externalId: string;
  name: string;
  state?: string; // future | active | closed
  startAt?: string;
  endAt?: string;
  goal?: string;
}

/**
 * One status change on a work item, from the source system's own change log.
 * Carried on the work-item event rather than as its own event type: the source
 * hands us the transitions attached to the issue, and keying them on the source
 * changelog id makes replaying the same issue idempotent.
 */
export interface PlanningTransitionRef {
  /** Source changelog entry id — stable per transition, used for de-duplication. */
  changelogId: string;
  /** Absent for the first transition (there is no status before creation). */
  fromStatus?: string;
  toStatus: string;
  /**
   * Workflow-independent buckets ("new" | "indeterminate" | "done") for the
   * status names above. Flow metrics classify on these because status names are
   * per-project and unbounded; absent when the name isn't in the site catalog.
   */
  fromCategory?: string;
  toCategory?: string;
  at: string; // ISO timestamp of the transition
  authorLogin?: string;
  authorName?: string;
}

export interface PlanningStoryPayload {
  externalKey: string; // e.g. PAY-2231
  projectKey: string; // e.g. PAY
  type?: string; // story | bug | task | spike | subtask | epic
  status: string;
  /**
   * Workflow-independent bucket for `status` — Jira's statusCategory key
   * ("new" | "indeterminate" | "done"). Status names are per-project and
   * unbounded, so flow metrics classify on this rather than on the name.
   */
  statusCategory?: string;
  storyPoints?: number;
  title: string;
  // Detailing dimensions (DASHBOARDS.md): hierarchy, sprint, release, assignee.
  epicKey?: string; // parent epic external key
  parentKey?: string; // parent story external key (subtasks)
  sprint?: PlanningSprintRef;
  releases?: string[]; // Jira fixVersion names
  assigneeLogin?: string;
  assigneeName?: string;
  priority?: string;
  resolvedAt?: string;
  /**
   * Status-transition timeline (`issue_status_history`, DATA-MODEL.md) — the
   * basis for cycle_time, wip/wip_age, flow_efficiency, blocked_time and
   * aging_work_items (METRICS.md), none of which are derivable from the
   * current status alone. Empty when the source didn't return a change log.
   */
  transitions?: PlanningTransitionRef[];
}
