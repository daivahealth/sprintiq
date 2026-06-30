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

export interface PlanningStoryPayload {
  externalKey: string; // e.g. PAY-2231
  projectKey: string; // e.g. PAY
  type?: string; // story | bug | task | spike
  status: string;
  storyPoints?: number;
  title: string;
}
