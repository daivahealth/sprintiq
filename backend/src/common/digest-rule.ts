/**
 * The rule the "no delivery signal on the previous working day" list is
 * computed from, in the one sentence every surface that shows the list must
 * display beside it (ADR-0009 condition 1).
 *
 * One constant for both surfaces (2026-10-19): the Teams card and the
 * admin-only Watchlist view. Two copies of a rule sentence drift, and the
 * condition is that the reader sees the rule the list was actually computed
 * from.
 */
export const DIGEST_RULE_TEXT =
  "Counts commits and PRs opened only — reviews and Jira aren't counted.";
