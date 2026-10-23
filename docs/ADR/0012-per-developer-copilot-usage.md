# ADR-0012: Per-developer Copilot usage on the Activity Overview roster

- **Status:** Accepted — implemented 2026-10-15
- **Date:** 2026-10-15
- **Deciders:** Product owner
- **Related:** [CLAUDE.md](../../CLAUDE.md) ("Metrics are ethics-first"), [ADR-0009](0009-attributed-commit-digest.md) (the second exception), [features/DASHBOARDS.md §4.4.1](../features/DASHBOARDS.md), [features/METRICS.md](../features/METRICS.md) (`copilot_active_days`, `copilot_lines_added`), [api/README.md §3, §6](../api/README.md), [architecture/DATA-MODEL.md](../architecture/DATA-MODEL.md), [deployment/README.md](../deployment/README.md)

## Context

A developer who spends a day working through Copilot — in the editor, the CLI or the agent — can look light, or idle, on every SprintIQ board. The commits they make are their own, so editor Copilot is invisible. The Copilot coding agent's commits and PRs are credited to a bot, not to the person who directed it. Linking agent work to people is a separate, still-deferred change. This decision is about **usage**: making visible how much each developer used Copilot.

GitHub publishes that per person. The org-level usage-metrics report `GET /orgs/{org}/copilot/metrics/reports/users-1-day?day=` returns signed download links to an NDJSON file. Each line holds one user's activity on one UTC day: interactions, generations, acceptances, lines suggested and added, and the features used. The legacy `/copilot/metrics` and user-engagement APIs were sunset in March–April 2026, and this report is their replacement.

A per-person usage figure beside a named developer is individual-level output. CLAUDE.md's ethics-first rule is default-deny for that, so it needs its own decision. The two earlier exceptions (the Sprint Health table and grade, decided 2026-09-07, and the commit digest, [ADR-0009](0009-attributed-commit-digest.md)) do not cover it.

## Decision

**Show each developer's Copilot usage as one column on the Activity Overview's "Active developers" roster. This is a new, independent exception to the ethics-first rule, decided 2026-10-15.**

The cell reads `6 days · 1,240 lines`, or `Seat, not used` / `No seat` / `None reported`:
- **Days** are distinct UTC report days on which GitHub reported any Copilot activity for the person. That means a user appears in the report with a non-zero interaction, generation or acceptance count.
- **Lines** is the sum of `loc_added_sum`, the lines Copilot added.
- **Seat status** comes from `GET /orgs/{org}/copilot/billing/seats`.

These conditions are load-bearing and enforced in code:

1. **Never an ordering.** The roster stays alphabetical, and Copilot is not one of its sort options (`activeDeveloperRoster`; the column header in `OverviewPage.tsx`). Copilot usage never decides who is on the roster: membership is still the commit-or-PR-opened signal shared with the digest.
2. **The rule ships with the column.** A caption under the table says what is counted, that it is context and never a score, how stale the data is ("data through `<day>` (UTC)"), and what GitHub cannot see: Copilot on github.com or mobile, and IDEs with telemetry off. So no data doesn't mean not using AI (`copilot-column.ts`).
3. **No column before there is data.** Until a report has been collected for the tenant, the API sends `copilot: null` on every row, and the column and caption are hidden. "—" on every row would read as "nobody uses Copilot."
4. **People only.** Bots, anonymized accounts and admin exclusions are dropped from the roster and from its tile together, so the Copilot agent never appears as a row.
5. **Lineage and audit.**
   - Every record GitHub sent is kept verbatim in the raw-event store.
   - Every sync run is recorded in `collectors_github_copilot_sync` and audit-logged (`collector.copilot_usage_sync`).
   - A manual run is audit-logged with the admin who asked for it.

**This decision does not extend anywhere else.** Copilot usage does not enter:
- the Sprint Health grade or table;
- the daily digest, its active-set definition or its withhold gates;
- the Watchlist;
- the Developer page;
- any notification.

Each of those needs its own decision, taken again. The same is true of any other Copilot figure GitHub reports (acceptance rate, AI credits), even though it is stored.

## Consequences

**The data is about two days late.** GitHub makes a day's report available about two full UTC days after it closes and finalizes it over about three. The sync re-reads its last three days so restatements land. A restated record gets a new idempotency key, because the key carries a content hash, and the projector applies it last-wins. A restated report that drops a user deletes that user's row for the day. The caption shows the newest day held, so a window ending today never implies today's usage is known.

**UTC days against IST windows.** The Overview's window is IST calendar days, while report days are UTC. A report day counts when its date falls in the window. The few hours at each end can belong to the neighbouring day. That is stated rather than re-bucketed: GitHub doesn't provide finer resolution.

**Usage is attributed to every org a user belongs to.** GitHub counts a person's Copilot activity in each org they are a member of. A tenant configured for one org sees the person's whole usage, including work done elsewhere. This is GitHub's model, and it is recorded here so it isn't mistaken for a bug.

**A separate, scoped token.** The sync uses its own secret ref (`copilotMetricsTokenRef`) and never falls back to the collector's token. It needs either an org owner's classic PAT with `read:org`, or a fine-grained token with "View organization Copilot metrics", SSO-authorized. The org's "Copilot usage metrics" policy must also be enabled. GitHub restricts the seat list to org owners, so a fine-grained token gets usage but not seat status, and those cells read "None reported". A missing permission shows up as `lastStatus: forbidden`, with a hint naming these three causes. The sync is off unless `GITHUB_COPILOT_USAGE_SYNC=on`.

## Alternatives considered

**Team-level adoption only (an org tile, no names).** This is the default the ethics rule prefers. It was rejected for this request: the problem being solved is a *person* reading as idle, and a team figure can't explain one person's row.

**Put the column on the Sprint Health productivity table.** Rejected. A column beside a grade reads as an input to it, and that table is ordered by score. The Overview roster is alphabetical and already framed as "activity context, never a ranking."

**Credit Copilot-agent commits to the developer instead.** This is a different change, and it is still deferred: who to credit, the `Co-authored-by:` developer or the one who started the agent, is its own decision. Usage metrics answer "did they use it" without deciding authorship.
