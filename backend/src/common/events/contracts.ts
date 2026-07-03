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

export interface PlanningStoryPayload {
  externalKey: string; // e.g. PAY-2231
  projectKey: string; // e.g. PAY
  type?: string; // story | bug | task | spike | subtask | epic
  status: string;
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
}
