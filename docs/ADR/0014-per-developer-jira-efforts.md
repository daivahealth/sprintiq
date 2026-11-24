# ADR-0014: Per-developer Jira efforts on Sprint Health (admin only)

- **Status:** Accepted — implemented 2026-11-23. The page is explicitly provisional and expected to change; any change to *who* it names, *what* it shows per person or *who can see it* needs this decision taken again.
- **Date:** 2026-11-23
- **Deciders:** Product owner
- **Related:** [CLAUDE.md](../../CLAUDE.md) ("Metrics are ethics-first"), [ADR-0009](0009-attributed-commit-digest.md) (whose admin-only, audited Watchlist view is the precedent followed here), [features/DASHBOARDS.md §4.1.5](../features/DASHBOARDS.md), [features/METRICS.md](../features/METRICS.md) (`effort_logged`), [api/README.md §6, §9](../api/README.md), [architecture/DATA-MODEL.md](../architecture/DATA-MODEL.md), [security/AUTH-AND-RBAC.md](../security/AUTH-AND-RBAC.md)

## Context

Sprint Health's panels describe a sprint through GitHub activity and Jira status changes. Neither shows what a team's Jira routine records daily: **time logged** against work (worklogs). The product owner asked for a Sprint Health subpage, "Efforts", showing it per day for a list of ten tracked developers.

Two things made this more than a UI change:

- **SprintIQ collected neither.** The Jira collector requested no worklogs and no creator; `planning_story` held only the current assignee. So the page needs new collection (worklogs and `creator`), a new table and a backfill.
- **It names people beside a per-day figure.** That is individual-level output, which CLAUDE.md's ethics-first rule denies by default. None of the earlier exceptions covers it — each is scoped to its own surface (the Sprint Health table and grade; ADR-0009's digest and Watchlist; ADR-0011's LOC chart; ADR-0012's Copilot column).

## Decision

**Show, on a Sprint Health subpage called Efforts, each of the first ten tracked developers' Jira hours logged per IST day, for the selected sprint across every project. This is a new, independent exception to the ethics-first rule, decided 2026-11-23. It inherits none of the earlier ones.**

These conditions are load-bearing and enforced in code:

1. **Admins only, every view audited.** The endpoint is `@Roles(Role.ADMIN)` and writes `dashboards.sprint_health.efforts.view` to the audit log on every read, recording the sprint, range and who was shown (`InsightsController.sprintEfforts`). The nav and route show the tab to admins only. Not modelled on the Developer page, which is open to every role and unaudited.
2. **The rule ships with the figures.** One constant, `EFFORTS_RULE_TEXT` (`backend/src/common/efforts-rule.ts`), returned in the payload and displayed under the grid. It states how hours are counted (worklog start day, IST, so a past day changes when someone backfills), that visibility-restricted worklogs are not counted, and that this is a record, not a productivity measure.
3. **Never a ranking.** People are chosen and listed **A–Z by display name** — the first ten after the sort, so which ten appear never depends on any figure. There are no per-person totals, no grade, no comparison and no sort by hours (`buildEfforts`, `sprint-efforts.ts`).
4. **Suppressions before anyone is named,** in the digest's order: roster entries identity resolution cannot place are counted, never named; bots, anonymized accounts, admin identity exclusions and live Watchlist exclusions are suppressed.
5. **Gaps are disclosed, never shown as zeros.** A tracked developer with no Jira account SprintIQ can link reads "No Jira account linked", not a row of zeros. The page states how many sprint items have never had their worklogs collected, how many worklogs could not be attributed, and how many tracked developers are not shown.
6. **Lineage.** Worklogs enter through the single ingestion pipeline as `planning.issue.worklogs` envelopes kept in the raw-event store; each `planning_worklog` row records the raw event it was last written from.

**This decision does not extend anywhere else.** Worklog hours do not enter the Sprint Health grade or table, the digest, the Watchlist, the Developer page, any notification or any other board. Showing them to another role, ranking by them, or adding another per-person figure to the page needs the decision taken again.

## How the data is collected

- **Worklogs.** The Jira search now requests `worklog` and `creator`. The search embeds at most 20 worklogs per issue; when `worklog.total` says there are more, `GET /rest/api/3/issue/{key}/worklog` completes the set. Each issue's set is one `planning.issue.worklogs` envelope keyed `jira:worklogs:v1:<issue>:<content hash>`, so an unchanged set de-dupes, an edit or deletion lands, and the poller and the backfill converge on one raw event.
- **Snapshot, not delta.** A **complete** set replaces the issue's rows: upsert present, delete absent. An **incomplete** set (the completion fetch failed) only upserts, so a partial read can never delete logged time. Only a complete set stamps `planning_story.worklogsCollectedAt`.
- **Backfill.** `JiraWorklogReconcilerService` runs in the backfill sweep and re-reads items never collected with a complete set, newest first. It sends worklogs through ingestion and fills a missing `creatorLogin/creatorName` directly (the story-date reconciler's precedent). It terminates: a row stops being a candidate once a complete set is stored, or once Jira no longer returns the issue.
- **Identity.** Worklog authors are resolved at read time by `DeveloperIdentityService.resolveJiraPeople`: the persisted Jira-assignee resolution first (it carries admin overrides), then the same `resolveJiraIdentity` ladder and overrides in memory. Nothing is written, deliberately — feeding these people into the persisted assignee pass would change the assignee coverage and "without assigned work" figures that ADR-0009's Watchlist publishes.

## Consequences

**Past days move.** Hours count on the day the work was *started* as the person logged it. Backfilled hours change an earlier day's figure. That is the honest reading of what was reported and is stated in the rule; the alternative (the day it was logged) would pile a weekly batch onto one day.

**Hidden worklogs are invisible.** A worklog restricted to a group or role the collecting account cannot see is absent from Jira's answer, and `complete` cannot detect that. Stated in the rule.

**Sprint scope is the sprint's items plus their subtasks, on the sprint's own days, in every project.** A carried-over item's time from before this sprint falls outside every column. Time logged on work outside the sprint is not shown. There is no project filter (2026-11-24): the ten people are a fixed list, independent of any project, so a project filter would only hide the part of their sprint logged elsewhere — and on a project they do not work on, would show ten rows of zeros. The picker lists every ongoing sprint in the tenant (`GET dashboards/sprint-health/efforts/sprints`, admin-only), newest first, with Jira-active sprints long past their end excluded by the Board's own staleness rule.

**The backfill takes a while.** One sweep reads up to 1,000 items (10 batches of 100) plus one request per issue with more than 20 worklogs; a tenant with ~18k items fills over a few hours of 10-minute ticks. Sync Status shows the backlog ("Jira worklogs and creators") and the page discloses unfilled items in the meantime.

**Manual migration.** `20261123100000_jira_worklogs_and_creator` adds three nullable `planning_story` columns and `planning_worklog`. It is additive and must be applied with `prisma migrate deploy` before the new build runs.

## Alternatives considered

**Team-level totals only (no names).** This is the default the ethics rule prefers. It was not what was asked for: the request is a per-person daily check-in.

**Open to every role, like the rest of Sprint Health.** Rejected: it would publish each person's hours to their peers. The admin-only, audited precedent (ADR-0009's Watchlist view) was chosen.

**Count hours on the day they were logged (`created`).** Rejected for the reason under Consequences.

**Also show subtasks created per day.** Shipped in the first draft of this change (credited to the immutable Jira `creator`, not the editable `reporter`) and removed before merge, 2026-11-23, at the product owner's request: the daily check-in is effort logged only. The collector still records each issue's `creator` (`planning_story.creator_login/creator_name`, filled by the same backfill) — issue metadata, displayed nowhere. Showing a per-person subtask figure again needs this decision taken again (condition: "adding another per-person figure").

**Resolve worklog authors in the persisted assignee pass.** Rejected for the reason under "Identity" above.
