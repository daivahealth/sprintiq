/**
 * Canonical domain-event payload contracts (the normalized shape every source
 * collector produces for a given event family). Neutral home so both collectors
 * (producers) and domain contexts (consumers) share one definition.
 */

/**
 * One submitted review on a pull request. Carried on the PR event rather than
 * as its own event type — the source hands us the reviews attached to the PR,
 * and keying them on the source's own review id makes re-collecting the same
 * PR idempotent (the same shape as `PlanningTransitionRef`).
 */
export interface CodeReviewRef {
  /** Source review id — stable per review, used for de-duplication. */
  externalId: string;
  reviewerLogin?: string;
  /** Automation rather than a person — excluded from people metrics (METRICS.md §0). */
  isBot: boolean;
  /** approved | changes_requested | commented | dismissed */
  state: string;
  submittedAt: string;
  /** Whether the review carried a written body (a summary note, not a comment count). */
  hasBody: boolean;
  /** Inline comments attributed to this review; 0 when none or when not counted. */
  commentCount?: number;
  /**
   * Whether the comment count actually ran. False leaves `commentCount`
   * meaningless — "not counted" must never be read as "reviewed without
   * commenting", which is the rubber-stamp finding.
   */
  commentsCounted?: boolean;
}

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
  /**
   * Derived by the collector from `reviews` below: the earliest review of any
   * kind, and the earliest `approved`. Both feed the pr_cycle_time sub-phases
   * (METRICS.md §2). Absent when the PR has no reviews.
   */
  firstReviewAt?: string;
  approvedAt?: string;
  mergedAt?: string;
  /** Login of whoever merged it — required for `self_merge_rate`. */
  mergedBy?: string;
  /**
   * The PR's review timeline (`pr_review`, DATA-MODEL.md) — the basis for
   * every metric in METRICS.md §3 and for the pr_cycle_time sub-phases,
   * none of which are derivable from the pull_request record alone.
   * Empty when the source returned no reviews.
   */
  reviews?: CodeReviewRef[];
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

/**
 * One change to a work item's sprint membership, from the source system's own
 * change log — the basis for `sprint_scope` (DATA-MODEL.md §4): committed at
 * start vs added/removed mid-sprint is unanswerable from current membership
 * alone. Same idempotent-replay shape as `PlanningTransitionRef`, keyed on the
 * changelog entry id.
 *
 * Carries sprint IDS only, already diffed into added/removed. Jira's Sprint
 * field accretes history (moving a story appends the new sprint; ids are a
 * comma-separated list), so the diff — not the raw value — is the event. Names
 * are deliberately absent: they resolve via the Sprint row, and sprint names
 * may themselves contain commas, which makes the name list unsplittable.
 */
export interface PlanningSprintChangeRef {
  /** Source changelog entry id — stable per change, used for de-duplication. */
  changelogId: string;
  addedSprintIds: string[];
  removedSprintIds: string[];
  at: string; // ISO timestamp of the change
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
  /**
   * When the item was created IN THE SOURCE SYSTEM (Jira's `fields.created`) —
   * NOT when we first ingested it. `lead_time` (METRICS.md) is
   * `resolvedAt - sourceCreatedAt`, and the row's own `createdAt` is the
   * backfill's run date, so using it would report the age of our database
   * rather than the age of the work. Absent on items collected before this
   * field was requested, until they are re-walked.
   */
  sourceCreatedAt?: string;
  resolvedAt?: string;
  /**
   * Status-transition timeline (`issue_status_history`, DATA-MODEL.md) — the
   * basis for cycle_time, wip/wip_age, flow_efficiency, blocked_time and
   * aging_work_items (METRICS.md), none of which are derivable from the
   * current status alone. Empty when the source didn't return a change log.
   */
  transitions?: PlanningTransitionRef[];
  /**
   * Sprint-membership timeline (`sprint_scope_change`, DATA-MODEL.md §4) — the
   * basis for sprint_commitment_reliability and scope_creep (METRICS.md),
   * neither of which is derivable from `sprint` (current membership) alone.
   * Empty when the source didn't return a change log.
   */
  sprintChanges?: PlanningSprintChangeRef[];
}
