/**
 * The rule the Sprint Health Efforts page is computed from, in the one place
 * every surface that shows those figures reads it (ADR-0014 condition 1 — the
 * rule ships with the attributed figures and is displayed beside them).
 *
 * One constant, like `DIGEST_RULE_TEXT`: two copies of a rule sentence drift.
 */
export const EFFORTS_RULE_TEXT =
  'Hours are Jira worklogs on this sprint’s items and their subtasks, counted on the day the work was logged as started (IST) — so a past day can change when someone backfills. ' +
  'Worklogs hidden from the collecting account by visibility restrictions are not counted. ' +
  'This is a record of what was logged, not a measure of productivity, and people are listed A–Z, never ranked.';
