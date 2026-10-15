# ADR-0011: The Developer page's daily chart leads with changed LOC

- **Status:** Accepted, implemented 2026-10-14
- **Date:** 2026-10-14
- **Deciders:** Product owner
- **Related:** [CLAUDE.md](../../CLAUDE.md) ("Metrics are ethics-first"), [features/DASHBOARDS.md §4.4.1 and §4.4.3](../features/DASHBOARDS.md), [api/README.md §9](../api/README.md), [ADR-0009](0009-attributed-commit-digest.md) (the previous exception)

## Context

CLAUDE.md treats per-person metrics as default-deny. Individual-level output exists to improve delivery, not to rank people. "LOC is never a productivity score." Any per-person exception needs an explicit, documented product decision. Two exceptions exist: the Sprint Health board (decided 2026-09-07) and the daily commit digest (ADR-0009, decided 2026-09-18).

Until now the Developer page showed one person's commits per day as bars, with changed LOC as an overlay on a *relative* scale. A relative line cannot answer "how much". The product owner asked for the activity charts to focus on lines of code rather than commits, including this per-developer chart.

The team- and project-level charts (the Overview's daily timeline and 12-month trend, and Project Activity) need no exception. They are team totals or codebases, not people. This ADR covers only the per-developer chart.

## Decision

The Developer page's daily chart gains a **Lines of code | Commits** toggle, with **Lines of code selected by default**:

- In LOC mode, each bar is that developer's changed lines for the day (additions + deletions, the sum, never a net), on an absolute axis labelled in lines.
- In Commits mode, each bar is that developer's commits for the day. The relative-scale overlay is removed because the toggle makes it redundant.
- Each bar's tooltip carries both quantities, whichever metric is drawn.

This is a third, independent exception to the ethics rule. It inherits nothing from the 2026-09-07 or 2026-09-18 decisions, and it is conditioned like them:

1. **The rule ships with the figure.** Directly under the chart, the page states that changed LOC is volume, not productivity, and that a large number is a large diff, nothing more.
2. **A partial figure is disclosed.** When some of the developer's commits in the window recorded no line changes (commits whose line stats are not collected yet, or that change no lines), the page says how many. A chart with commits but no line changes says so instead of drawing an empty axis.
3. **No comparison with anyone else.** The Developer page shows no rank, percentile, team average or other developer's figure next to the chart.

## Consequences

- Per-person LOC is the default view on one page, for one person at a time. This is a deliberate shift, and the conditions above are what keep it from becoming a score.
- **This does not extend LOC to anything else about people.** It is not an input to the Sprint Health grade (still tickets, PRs and reviews only), the digest, the Watchlist or any ordering of people:
  - the Overview roster still never sorts by LOC;
  - the daily timeline's drill-down still lists contributors by commits, alphabetically.
  Each of those would need its own decision.
- **Merge commits inflate LOC until they are excluded.** This decision assumed a merge commit records no line changes. Measured on 2026-10-15, 98% of merge commits carry line counts: GitHub reports a merge commit's diff against its first parent, so a merged branch's lines are counted twice, and they are credited to whoever merged it. On 2026-10-14 merges were 51,197 of the 125,644 changed lines (41%). METRICS.md §0 already requires merge commits to be excluded from authorship churn. Until that lands (api/README.md §12 row 12), any per-person LOC figure on this page can include lines the person merged rather than wrote.
- Line stats are only as complete as collection. Commits ingested without stats show 0 lines until the commit-stats reconciler fills them, which is why condition 2 exists.

## Alternatives considered

- **Keep commits as the default and offer LOC as the alternative.** This was declined at the product owner's request.
- **Keep the relative LOC overlay.** It was rejected because a relative scale cannot say how much, and with a toggle each metric gets its own absolute axis.
- **Leave the per-developer chart unchanged** and refocus only the team and project charts. This was offered first and superseded by this decision.
