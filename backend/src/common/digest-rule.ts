/**
 * The rule the "no delivery signal on the previous working day" list is
 * computed from, in the one sentence every surface that shows the list must
 * display beside it (ADR-0009 condition 1).
 *
 * Shown beside the list on the admin-only Watchlist view. It was also on the
 * Teams card until the ADR-0009 amendment of 2026-11-03 removed it from
 * there; keep this the single source if the card ever displays the rule
 * again — two copies of a rule sentence drift.
 */
export const DIGEST_RULE_TEXT =
  "Counts commits and PRs opened only — reviews and Jira aren't counted.";
