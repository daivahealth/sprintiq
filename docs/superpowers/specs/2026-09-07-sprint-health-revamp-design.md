# Sprint Health: sprint-scoped delivery detail

**Date:** 2026-09-07
**Status:** Approved design, not yet implemented
**Scope:** `/sprint-health` board detail; one new Jira collector read (project versions); three new BFF reads; one new user-input mutation; new fields on `planning_release` and `planning_story`.

This is a working design document. The durable rules it settles belong in the
canonical docs — `DASHBOARDS.md`, `METRICS.md`, `docs/api/README.md`,
`DATA-MODEL.md` — and must be written there as part of the implementation, not
left here.

## 1. Problem

`/sprint-health` answers one question well: *which sprint is in trouble?* The
multi-project pace cards rank concurrent active sprints worst-first, and
clicking one shows completion, elapsed, code linkage and by-type progress.

It does not answer the follow-up: *what actually happened in this sprint?* Who
moved tickets and on which days, who wrote the code, how much shipped, how much
came back as defects, and what each release candidate contained when it was
cut. That detail exists across the delivery graph today and is not surfaced
anywhere sprint-scoped — the Engineering Activity section computes the
per-developer figures, but over a rolling date window, not a sprint.

A mockup ("Team & Code Activity") was supplied as the target. This design
adopts it as the Sprint Health detail.

## 2. Feasibility findings that shaped the design

Verified before designing, against the code and against Atlassian's published
OpenAPI spec for Jira Cloud v3.

**Already collected, no collector work:**

| Element | Source |
|---|---|
| Commits, PRs raised, PRs reviewed, time to first review | `code_commit`, `code_pull_request.firstReviewAt`, `code_review.submittedAt` |
| LOC added/removed per developer | `code_commit.additions` / `.deletions` |
| Tickets moved per developer per day | `planning_issue_status_history` — `transitionedAt` + `authorLogin`/`authorName`, written from the Jira changelog |
| Stories released; reopened / rolled back | `planning_story.releases` + done→not-done transitions in the status history |
| Bugs by priority | `planning_story` rows with `type='bug'` and `priority` |
| RC contents (delivered / pending per story) | `planning_story.releases` + `statusCategory` |

**Obtainable from Jira, needs a collector change:**

- **Version dates and released flag.** `GET /rest/api/3/project/{key}/versions`
  is never called. `PlanningService.upsertRelease` writes only the fixVersion
  *name*, so `planning_release.releaseDate` and `.released` — columns that
  already exist — are permanently empty.
- **"Bugs logged against this RC."** In Jira `fixVersions` means *will be fixed
  in*; the *found in* field is **Affects Version** (`versions`), which
  `BASE_SEARCH_FIELDS` does not request. Counting fixVersions here would answer
  a different question while looking like this one.

**Not available from Jira at all:**

- **A version's actual release date.** The `Version` object carries exactly
  `startDate`, `releaseDate` ("the date on which work is expected to finish"),
  `released`, `overdue` and `archived`. There is no second date field.
  Releasing a version overwrites `releaseDate` with the release day, so the
  plan is destroyed at the moment you would want to compare against it.
- **Test execution results.** The Jira v3 spec contains no test-management
  endpoints. Passed/Failed/Blocked/WIP/Not Run live in a separate app with its
  own API and credentials.

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Test execution ships as a **labelled placeholder**, not a metric | The data lives in a separate test-management app that is not connected. A placeholder that names the source is honest; an omitted panel silently loses a requirement, and a fabricated one is worse than both |
| D2 | RCs are **Jira releases (fixVersions)** | Confirmed as how the team models them |
| D3 | Planned release date is **user input held in SprintIQ**; actual comes from Jira | Jira cannot answer it (§2). The platform already has a precedent for recording a human judgement — `WatchlistExclusion` — and this follows it: named author, audited, tenant-scoped |
| D4 | The pace cards **stay**; only the detail below them is replaced | They answer "which sprint is in trouble", which nothing in the mockup does |
| D5 | The **highest/lowest contributor cards and the productivity grade ship as drawn** | Explicit product decision, taken with the conflict stated. It contradicts the standing anti-leaderboard rule, so that rule is amended in the same session (§8) rather than quietly broken |
| D6 | "Bugs logged against this RC" reads **Affects Version**, falling back to fixVersion | See §2. The fallback is labelled in the UI so the reader knows which question the number answers |

## 4. Data and collection changes

### 4.1 Jira client — one new read

`JiraClient.getProjectVersions(siteUrl, email, apiToken, projectKey)` →
`GET /rest/api/3/project/{projectIdOrKey}/versions`, returning `id`, `name`,
`startDate`, `releaseDate`, `released`, `archived`, `overdue`. Same auth,
rate-limit and error handling as the existing reads; no pagination (the
endpoint returns the full list).

### 4.2 Collector — one new event

`JiraCollector.sync` emits `planning.version.upserted`
(`EventTypes.PLANNING_VERSION_UPSERTED`) once per version per tick, alongside
the existing `planning.issue.*` envelopes and through the same ingestion
pipeline. Nothing outside BC-1 talks to Jira.

**Which projects.** `config.projectKey` when the connection sets one; otherwise
the project keys the collector has **itself observed** on issues it collected,
accumulated in its own `syncCursors.versionProjectKeys` (capped at 50, most
recent wins).

Deliberately *not* read from `planning_release`: that table belongs to BC-3,
and a collector querying it would be exactly the cross-context DB coupling the
architecture forbids — the coupling that would have to be unpicked first if
collectors were ever extracted into their own service. The collector already
sees every project key it needs on the issues passing through it, so it can
answer this from its own state.

**Idempotency.** Versions carry no `updated` field, so the key hashes the
mutable content:
`jira:version:v1:{versionId}:{sha256(name|startDate|releaseDate|released|archived)}`.
An unchanged version re-emits the same key every tick and de-dupes at the
raw-event store, exactly like an unchanged issue.

### 4.3 Planning service

Subscribes to the new event and extends `upsertRelease` to write `externalId`,
`startAt`, `releaseDate`, `released` and `archived`. The existing
fixVersion-name path stays: a name seen on an issue still creates the row, and
the version event fills in the rest. Neither path may overwrite user input
(§4.4) — they touch disjoint columns.

### 4.4 Schema

`planning_release` gains:

| Column | Meaning |
|---|---|
| `externalId String?` | Jira version id, so the version event can match a row created from a bare name |
| `startAt DateTime?` | Jira `startDate` |
| `archived Boolean @default(false)` | Jira `archived` |
| `plannedReleaseAt DateTime?` | **User input.** The date the RC was planned for, entered in SprintIQ because Jira destroys it on release |
| `plannedSetByUserId String?` | Who entered it. A human judgement carries a name |
| `plannedSetAt DateTime?` | When they entered it |

`planning_story` gains `affectsReleases String[] @default([])` — Jira's
`versions` (Affects Version/s), added to `BASE_SEARCH_FIELDS`.

Both migrations are additive; no backfill is required for the board to render
(every new field degrades to "unknown", which the UI states rather than hides).
Existing stories carry an empty `affectsReleases` until re-walked, which is why
D6 specifies a labelled fallback rather than a silent zero.

## 5. API

All routes are tenant-scoped through the existing guard and `TenantContext`,
and mutations are audited by the global `AuditInterceptor`.

### 5.1 Reads (BFF)

Split by refresh cadence, not by convenience — the check-in grid is paged by
date range and must not re-run the sprint aggregates on every page flip.

| Route | Returns |
|---|---|
| `GET /api/dashboards/sprint-health?sprint=` | **Extended.** Existing `SprintHealthView` plus `commitActivity`, `productivity` and `qualityCheck` |
| `GET /api/dashboards/sprint-health/check-ins?sprint=&from=&to=` | Per-developer × per-day transition counts for the requested range, plus the sprint's own day bounds so the pager can clamp |
| `GET /api/dashboards/sprint-health/release-candidates?sprint=` | One entry per release carried by the sprint's stories: dates, delivered/pending story list, bug counts by priority, and `testExecution: null` |

### 5.2 Mutation — planned release date

`PUT /api/dashboards/release-plan` `{ projectKey, name, plannedReleaseAt }` and
`DELETE /api/dashboards/release-plan?projectKey=&name=`. Modelled on
`WatchlistExclusionsController`: `@Roles(Role.ADMIN)`, records
`plannedSetByUserId`, audited. Rejects a planned date more than a year from the
release's own dates, on the same reasoning as the exclusion cap — a nonsense
plan produces a nonsense lateness figure on a board people act on.

## 6. Metric definitions

Every figure below gets an entry in `METRICS.md` with this wording. Where a
definition involves a judgement, the UI states it inline — the board must not
present a chosen rule as a fact of nature.

**Commit activity (5 tiles)**

- *Developers who committed* — distinct commit authors in the sprint window,
  over distinct assignees on the sprint's items ("of N assigned to sprint").
- *Commits this sprint* — commits authored in `[startAt, min(now, endAt)]` on
  repos mapped to the sprint's project by the existing
  `InsightsService.repoToProjects` helper (the same delivery-graph mapping
  Project Activity uses), with the daily average.
  **Two stated assumptions.** Git has no sprint field, so this is a *window*,
  not a linkage; the alternative — only commits linked to the sprint's stories
  — is more precise but undercounts silently wherever Jira-key linkage is
  missing. And a repo reaches a project only through that mapping, so a repo
  that has never carried a linked PR contributes nothing here. Both are stated
  on the panel.
- *PRs raised* — PRs opened in the window, split open/merged.
- *PRs reviewed* — PRs with at least one review submitted in the window, and
  that as a percentage of raised.
- *Avg time to first review* — mean of `firstReviewAt - createdAt` over PRs
  raised in the window, plus a count of those still waiting over 24h. Null when
  no PR in the window has been reviewed; rendered "—", never 0.

**Daily check-ins** — count of `planning_issue_status_history` rows per
`authorLogin` per calendar day in the selected range. This counts *who moved
the ticket*, which is not always the assignee; the panel says so. Pages in
7-day windows clamped to the sprint's active days. Day bucketing uses the
existing `istDateKey` helper, the same one every other daily series on the
platform uses — two boards disagreeing about where a day ends is a defect the
reader can neither see nor explain.

**Productivity table** — per developer over the sprint window: LOC added and
removed, tickets worked (distinct items they transitioned), commits, PRs
raised, PRs reviewed. Plus a `high | medium | low` grade (D5) computed from
**tertiles of a composite of tickets completed + PRs raised + reviews
submitted, across that sprint's contributors — deliberately not LOC** — with
the rule printed under the table so the grade is auditable rather than
oracular. The highest/lowest contributor cards rank on LOC added, as drawn.

**Quality check** — stories released this sprint (items whose `releases` is
non-empty and which reached done in the window); rolled back / reopened (items
that left a done status after having entered one); bugs logged by priority
(`type='bug'` created in the window); and bugs-per-story-released.

**RC cards** — one per release: planned date (user input), actual date (Jira
`releaseDate` where `released`), lateness in days when both exist and nothing
otherwise; stories delivered `n/m` with the full list and per-story status;
bugs by priority via Affects Version (D6); and the test-execution placeholder.

## 7. Frontend

New directory `frontend/src/modules/dashboards/sprint-health/`, mirroring how
`developer-activity/` is organised:

- `SprintHealthBoard` keeps the pace cards and sprint selection, and renders
  the sections below when a sprint is selected
- `CommitActivityTiles`, `CheckInGrid`, `ProductivityPanel`,
  `QualityCheckPanel`, `ReleaseCandidateList`, `PlannedDateField`
- Hooks alongside the existing ones in `useInsights.ts`

Built on the existing primitives (`Card`, `Badge`, `Table`, `Stat`, `BarList`,
`ProvenanceNote`, `FreshnessNote`) and on semantic design tokens only — no raw
Tailwind palette classes, per `DESIGN-SYSTEM.md`. The mockup's dark palette maps
onto existing tokens; it does not introduce a second theme.

`FreshnessNote` is mounted already and stays. Each panel that rests on a
judgement (the commit window, the check-in authorship, the productivity rule,
the Affects-Version fallback) states it inline.

## 8. Policy amendment

`CLAUDE.md` and `AGENTS.md` currently forbid individual ranking outright
("Don't build individual leaderboards, ranking, or surveillance features";
"LOC is never a productivity score"). D5 ships exactly that. Both files are
amended in the same session — they are required to stay materially aligned — to
record that per-developer contribution ranking is permitted on the Sprint
Health board, with the reasoning and the date, so that code and policy do not
contradict each other. This is the "no silent drift" rule applied to the rule
itself.

## 9. Documentation to update

| Doc | Change |
|---|---|
| `docs/features/DASHBOARDS.md` | Rewrite the Sprint Health row and section: pace cards plus five detail sections |
| `docs/features/METRICS.md` | The definitions in §6, each with its stated judgement |
| `docs/api/README.md` §9 | Three new BFF reads, one new mutation |
| `docs/api/README.md` §12 | Test execution recorded as an open gap, with the reason (separate app) |
| `docs/architecture/DATA-MODEL.md` | New `planning_release` and `planning_story` columns |
| `CLAUDE.md`, `AGENTS.md` | §8 |

## 10. Verification

- Backend: Jest specs per new service method — the version client read, the
  collector's idempotency key, the planning upsert's column disjointness, and
  each of the three read shapes including their null/empty cases.
- A tenant-isolation test on every new route, per the standing rule that
  isolation is tested rather than assumed.
- Frontend: `tsc`, `lint:ci` (not `lint`, which auto-fixes and therefore cannot
  fail), `build`, and unit tests.
- Browser verification is unavailable in this environment; whatever that leaves
  unverified is stated plainly rather than implied to have passed.

## 11. Out of scope

- Test execution collection — deferred to a future test-management collector.
- Lateness for RCs released before a planned date was entered: there is nothing
  to compare against and none will be invented.
- Any change to Engineering Activity, which keeps answering the rolling-window
  question. The per-developer aggregation is factored into a shared method so
  both boards compute LOC, commits and PR counts identically.
