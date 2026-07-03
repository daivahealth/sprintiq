/**
 * Canonical domain event type identifiers (source-agnostic). Collectors emit
 * these regardless of which source produced them; downstream contexts subscribe
 * by type. See docs/api/README.md §6.
 */
export const EventTypes = {
  CODE_PR_OPENED: 'code.pull_request.opened',
  CODE_PR_UPDATED: 'code.pull_request.updated',
  CODE_PR_MERGED: 'code.pull_request.merged',
  CODE_PR_CLOSED: 'code.pull_request.closed',
  CODE_COMMIT_PUSHED: 'code.commit.pushed',
  PLANNING_STORY_CREATED: 'planning.issue.created',
  PLANNING_STORY_UPDATED: 'planning.issue.updated',
} as const;

export const CODE_PR_EVENT_TYPES: string[] = [
  EventTypes.CODE_PR_OPENED,
  EventTypes.CODE_PR_UPDATED,
  EventTypes.CODE_PR_MERGED,
  EventTypes.CODE_PR_CLOSED,
];

export const PLANNING_STORY_EVENT_TYPES: string[] = [
  EventTypes.PLANNING_STORY_CREATED,
  EventTypes.PLANNING_STORY_UPDATED,
];
