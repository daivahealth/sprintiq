# Frontend & Dashboards Plan

Canonical frontend/dashboard spec for SprintIQ at real scale: **~200 repositories, ~60 projects**, many concurrent sprints — **common, metric-centric dashboards** (not persona pages) with **role-based assignment**, **bi-directional Jira↔GitHub tracking**, and **work-item detailing at every granularity** (story / sub-task / bug / epic / developer / release / sprint).

> Context: [PRODUCT-ARCHITECTURE.md §9](../architecture/PRODUCT-ARCHITECTURE.md) (KPI inventories — used as *content* input for widgets, not as page structure), [METRICS.md](METRICS.md) (metric catalog), [AUTH-AND-RBAC.md](../security/AUTH-AND-RBAC.md) (roles, metric ethics).

---

## 1. Product decisions (settled)

1. **Common dashboards, not persona pages.** Dashboards are named after *what they measure* — Sprint Health, Sprint Risk, Velocity, Forecasting, Productivity, Efficiency, Delivery Explorer. Personas are served by **assigning dashboards to roles**, not by bespoke persona pages.
2. **Role-based assignment.** Each dashboard carries a role list; `GET /api/dashboards/assignments` returns the dashboards for the current user's roles and drives the nav. Default: all dashboards → all roles; per-tenant admin-configurable assignment is the follow-up (admin UI over the same registry).
3. **Bi-directional Jira↔GitHub tracking everywhere.** Every dashboard exposes both directions of the correlation graph: work items → their linked PRs (Jira→GitHub) and PRs → their work items (GitHub→Jira), with coverage percentages and orphans surfaced.
4. **Detailing at every granularity** — the backend read models answer story-wise, sub-task-wise, bug-wise, epic-wise, developer-wise, release-wise, sprint-wise questions (see §3).
5. Numbers are computed server-side from persisted facts + correlation links; missing data renders as missing (never fabricated), with sample size/freshness shown. **Freshness is rendered on every board** (`FreshnessNote` → `GET /api/dashboards/freshness`): with poll-only ingestion on a 4-hour default interval, the page being a second old says nothing about the data in it. It shows the oldest **completeness watermark** (`collectedThroughAt` — how much of the source is collected, not when the API was last called) across active connections, and calls out still-backfilling, never-synced and failing connections separately. It rides in the shared Scope Bar; boards with their own `FilterBar` mount it directly (§8).

---

## 2. Current state (implemented)

- **Data model (planning):** full Jira hierarchy — epics and sub-tasks are typed work-item rows (`type` ∈ story|bug|task|spike|subtask|epic) with `epicKey`/`parentKey`; `Sprint` and `Release` (fixVersion) entities; sprint/release/assignee/priority/resolvedAt on every item. Jira collector parses parent/epic, sprint, fixVersions, assignee, resolutiondate and Jira's own `created` date via the scheduled poller (webhooks are deferred — [api/README.md §12](../api/README.md#12-jira--github-mvp-implementation-status) #2).
- **Insight read models (BC-8 `InsightsService`):** sprint-health, sprint-risk, velocity (per closed sprint), forecast (avg velocity vs open backlog), productivity (weekly items/points/PRs/LOC), efficiency (PR + story cycle times, bi-directional traceability), work-items detail (any granularity, each row with its linked PRs).
- **BFF endpoints:** `/api/dashboards/{assignments, work-items, sprint-health, sprint-risk, velocity, forecast, productivity, efficiency, metrics}`, catalogs `/api/catalog/{projects, repos, sprints, epics, releases}`.
- **Frontend:** URL-synced Scope Bar (projects × repos × time × groupBy, delivery-graph cross-filtering), role-driven nav from `/assignments`, and seven dashboards: Delivery Explorer + the six common boards.
- **Still missing (dashboard-side):** per-tenant assignment admin UI, saved views, team catalog/grouping, lineage drill-through UI, DORA/quality boards (need CI/quality collectors).
- **Still missing (collection-side):** tracked in [api/README.md §12](../api/README.md#12-jira--github-mvp-implementation-status) — the register of Jira/GitHub gaps and their status. Sprint scope-change (committed-at-start) history is #8 there; it's why "committed" below means *currently attached to the sprint*.

---

## 3. Detailing model — every granularity queryable

One work-item table (`planning_story`) holds all Jira issue types, so any slice is a filter, not a new schema:

| Granularity | How it's answered |
|---|---|
| **Story-wise / bug-wise / sub-task-wise** | `GET /api/dashboards/work-items?types=story\|bug\|subtask&…` — rows include status, points, assignee, epic, sprint, releases, **linked PRs with state** |
| **Epic-wise** | epics are `type='epic'` rows; children filter by `epicKey`; catalog: `/api/catalog/epics` |
| **Sprint-wise** | `Sprint` entity + `sprintExternalId` on items; boards: Sprint Health / Sprint Risk / Velocity; catalog: `/api/catalog/sprints` |
| **Release-wise** | `Release` entity (fixVersions) + `releases[]` on items; filter `?release=…`; catalog: `/api/catalog/releases` |
| **Developer-wise** | `assigneeLogin/Name` on items + PR `authorLogin`; grouped views are **activity context, never ranking** (ethics rules) |
| **Repo/project-wise** | existing scope system + batch `/api/dashboards/metrics` (groupBy repo/project/developer/day) |

Bi-directional tracking primitive: `correlation_link (pr_implements_story)` read both ways — `prRefsByStoryId` (Jira→GitHub) and ref-matching over PRs (GitHub→Jira). Efficiency board reports both coverage percentages; orphan PRs/items are counted, not hidden.

## 4. The common dashboards

| Dashboard | Route | Reads | Core content |
|---|---|---|---|
| **Delivery Explorer** | `/` | `dashboards/metrics` | any metric × scope × groupBy (repo/project/developer/day) table, listed by Changed LOC descending — **except `groupBy=developer`, which is alphabetical** (see §4.1) |
| **Sprint Health** | `/sprint-health` | `dashboards/sprint-health/active` + `dashboards/sprint-health` | **multi-project default: one card per concurrent active sprint** (each project runs its own lifecycle), ranked worst-pace-first with **cadence-normalized pace** (completion % vs elapsed % of that sprint's own window → on-track/at-risk/behind); click to drill into committed vs completed, code linkage, by-type progress |
| **Sprint Risk** | `/sprint-risk` | `dashboards/sprint-risk/active` + `dashboards/sprint-risk` | **multi-project default: one risk card per concurrent active sprint**, ranked most-at-risk-first; project picker; click to drill into open items **without linked code** (at-risk pts), open bugs, unestimated work — each row with its PRs. Long item titles stay within the Item column and truncate rather than obscuring adjacent data. |
| **Velocity** | `/velocity` | `dashboards/velocity` | **one section per project**, sprints ordered current → past with the running sprint first; rows click through to that sprint on Sprint Health. Falls back to items-completed where estimate coverage is too low for points to mean anything (§4.3) |
| **Forecasting** | `/forecast` | `dashboards/forecast` | avg velocity (last 3 closed) vs remaining backlog → sprints needed + projected date. Projects from **items** rather than points where estimate coverage is below the floor, showing the points answer alongside so the gap is visible (§4.3) |
| **Productivity** | `/productivity` | `dashboards/productivity` | weekly throughput: items + points (Jira) and merged PRs + LOC (GitHub) — team-level |
| **Efficiency** | `/efficiency` | `dashboards/efficiency` | PR cycle p50/p85, story cycle p50/p85, **traceability both directions** |
| **Project Activity** | `/project-activity` | `dashboards/project-activity` | most-active projects by **commits + LOC across all mapped repos** (delivery graph), day/week/month windows; unlinked repos bucketed honestly |
| **Developer Activity** | `/developer-activity` | `dashboards/developer-activity` | GitHub-style per-developer profile: commit history (sha/±LOC), repos committed to, lines committed, commits-per-day, PRs authored (**and how many merged**), **active projects** via the graph, plus the **identities the figures were gathered under** — activity context, never a ranking |
| **Top Repos** | `/top-repos` | `dashboards/metrics` (groupBy=repo, fixed) | Repos ranked by Changed LOC, top 20 by default with a "show all N repos" expansion — repo-level ranking only, never individual |
| **Team Capacity** | `/team-capacity` | `dashboards/metrics` (groupBy=developer, fixed) + developer catalog | Alphabetical roster diff — developers with **no PR activity in the window** (a staffing/blocker signal); intentionally unsorted by volume, never a leaderboard |

Top Repos and Team Capacity force their `groupBy` (via `useBatchMetrics`'s explicit override) and hide the Scope Bar's Group-by toggle (`ScopeBar`'s `showGroupBy={false}`) — they are dedicated single-purpose screens, not configurable views like Delivery Explorer.

### 4.1 Two boards, one person: stating each board's denominator

Delivery Explorer (`groupBy=developer`) and Developer Activity both answer "what did this person do", and they will not agree — by design. They must therefore each say what they count, because an unexplained gap between them reads as a bug in the data:

| | Delivery Explorer, grouped by developer | Developer Activity |
|---|---|---|
| Unit | pull requests | commits |
| Included | **merged only** | commits landed in the window; PRs in **all states** |
| Windowed on | `mergedAt` | `committedAt` (commits) / `openedAt` (PRs) |
| Window edges | rolling UTC (`now − days`) | IST calendar-aligned (`istWindowFloor`) |
| LOC means | PR diff size | commit diff size |

PR diff size is not the sum of its commits (rebases and merge bases see to that), so the two LOC figures are different measurements, not a reconciliation to chase. Developer Activity reports `prsMerged` beside `prsAuthored` so the PR-count difference is visible on the page rather than inferred by comparing screens.

**Neither board may rank individuals.** Delivery Explorer sorts by Changed LOC descending for every grouping *except* developer, where rows are alphabetical — sorting people by lines changed is precisely the leaderboard CLAUDE.md forbids and that Team Capacity is deliberately built to avoid. LOC is change-volume context, never a productivity score.

### 4.1.1 One definition of "when"

Every window and every bucket in the app is **IST calendar-aligned**, via `istWindowFloor` / `istDateKey` / `istWeekKey` (backend `common/time.ts`, mirrored in `frontend/src/lib/utils.ts`).

This was three conventions until they were unified: the Scope Bar sent a rolling `now − days×86400000`, the activity boards bucketed by IST day, and Productivity bucketed weeks on the **UTC** Sunday. "Last 7 days" therefore denoted three different ranges depending on the board, differing by up to a full day at each edge, and a PR merged after 18:30 IST was filed under tomorrow on one screen and today on another. Adding a new window or bucket means reusing these helpers, not writing another date expression.

### 4.1.2 Sprints Jira still calls active

Jira never closes a sprint by itself — `state` is whatever someone last set. A team that stops using a board leaves its final sprint `active` indefinitely; on the reference tenant one had been "active" for over four years and rendered as a live card at 100% elapsed, 0 days remaining, pace "behind", permanently, beside the sprint actually running.

An active sprint whose `endAt` passed more than **`STALE_ACTIVE_SPRINT_GRACE_DAYS` (14)** ago is therefore treated as stale: excluded from the ranked active cards on Sprint Health and Sprint Risk, and reported separately with how far past its end it is. Excluded because it is 100% elapsed by definition, so pace-ranking always floats it above the sprint that can still be acted on; **reported rather than hidden** because the sprint is real and someone needs to close it — hiding it would trade a misleading card for a silent omission. A short overrun is ordinary and stays in the normal cards, which is what the grace period is for.

Unstarted (`future`) sprints are likewise kept out of the sprint picker, which requests `state=active,closed`: they have no dates, no transitions and nothing delivered, so every figure these boards compute is empty for one. Note also that sprint ordering must specify `nulls: 'last'` — Postgres sorts `NULL` **first** on a descending sort, so a dateless future sprint otherwise outranked every real one and arrived at the top of the picker.

### 4.1.3 Daily activity section (who committed, day by day)

Developer Activity opens with a team-level daily commit log (`GET /api/dashboards/developer-activity/daily?window=`): one row per IST day, newest first, with the day's **total commit count** and **every developer who committed** that day, each with their count. Attribution runs through the identity map in bulk (`DeveloperIdentityService.attributionIndex`) so unverified-email commits count under the right person; commits matching no identity appear as **"+N unattributed"** per day — disclosed, never dropped or guessed. A truncated read says so on screen instead of under-reporting silently.

**Ordering within a day is alphabetical by default**, per the no-ranking rule above (§4.1). The section also carries an explicit **"Most commits" sort toggle** — a recorded, owner-requested deviation from the "never ordered by volume" default (2026-08-14): the volume ordering exists only as the reader's deliberate act in the UI, is never the default, never persisted, and the API always returns alphabetical order. It remains commit *count* context for "who was active", not a productivity score — LOC is deliberately absent from this section.

### 4.3 Velocity: why it is grouped, and when points stop meaning anything

**Grouped by project.** Velocity does not survive being pooled. Each team estimates on its own scale, so a single series mixing projects invites comparing bars that measure different things — the board previously showed six sprints spanning five projects as one sequence. Each project now gets its own section, ordered **current → past** with the running sprint leading, and each row clicks through to that sprint on Sprint Health (which is why sprint selection lives in the URL, §3).

**The running sprint is shown but never averaged.** It has completed a fraction of its work because it is a fraction of the way through; averaging it in would make velocity depend on which day the page is opened. It renders at half opacity with a marker for elapsed %, and is excluded from `avgCompletedPoints` / `avgCompletedItems` and from the forecast sample.

**The collection horizon gates the whole row.** Collection is windowed — nothing before a connection's `backfillSince` was ever fetched — so a sprint that closed earlier holds only the handful of its items touched since. Those sprints are marked `beyondHorizon`, rendered as `partial`, and **excluded from every average**. Shown rather than hidden, because the sprint is real and the gap is the point: it tells you the history predates the data, which a deeper backfill fixes (`POST /admin/configurations/{source}/rebackfill`, api/README §9).

This is not hypothetical. Before the guard, ACT's Velocity averaged its last 6 closed sprints — three of which sat past the floor holding 1, 3 and 21 items instead of hundreds — and reported **241** items per sprint, while Forecasting sampled 3 and reported **475**. Same project, same database, 2× apart. With the guard both read 475.

**Estimate coverage gates the points figures.** `committedPoints` and `completedPoints` can only see items that carry a story-point estimate. Where most items don't, those figures describe a minority of the sprint while presenting themselves as the whole of it. On the reference tenant this was severe and not obvious:

| Sprint | items done | completed points | estimate coverage |
|---|---|---|---|
| ACT Sprint-26-7 | 258 / 346 | **17** / 261 | 27% |
| ACT Sprint-26-6 | 777 / 1025 | **33** / 1374 | 25% |
| CIHL Sprint-26-8 (running) | 1263 / 1910 | **0** / 3198 | 20% |

Three-quarters of the work carried no estimate, *and the items being completed were overwhelmingly those unestimated ones* — so velocity read at ~2% of committed points while roughly 76% of each sprint was actually finished. The chart wasn't pessimistic; it was measuring a different quantity under velocity's name.

Below **`MIN_ESTIMATE_COVERAGE_PCT` (70%)** the board therefore leads with **items completed**, states the coverage and why, and Forecasting does the same. A sprint nobody estimated is excluded from the points average entirely rather than counted as a zero — otherwise a team reads as slowing down when all that changed is that they stopped estimating.

This is not cosmetic. The same data through the two paths:

| ACT forecast | Projection | Finish |
|---|---|---|
| by points | 180 sprints | 2044 |
| by items | 7 sprints | 2027 |

The points answer is still shown, labelled, so the cost of the estimating gap is visible rather than hidden — closing it is what makes the points forecast usable again.

### 4.2 Attribution coverage

Any board that counts commits must disclose how many of them can be attributed to a person at all. GitHub resolves a commit's account only when its email is verified there, so a commit routinely arrives with a name, an email, and no login (DATA-MODEL.md §3, api/README.md §12 #22). This matters on screen because **"0 commits" and "commits we cannot attribute" look identical and mean opposite things**:

- **Developer Activity** names the identities behind its figures. When commits were recovered through a non-login identity it says so; when the total is zero and nothing was recovered, it says the likely cause rather than presenting the zero as a finding.
- **Project Activity** shows `unattributedCommits` per row and a window-level coverage note. Those commits *are* counted in `commits`/`locChanged` but cannot be counted in `contributors` — without the disclosure the row reports more work than people to do it.
- **The developer picker lists people with no matched GitHub account**, marked "no linked account", rather than omitting them. Omitting them is what made their work look like nobody's.

All boards sit on the **Scope Bar** (projects/repos/time, URL-synced, graph cross-filtered); sprint boards add a sprint picker (auto-selects the active sprint in scope).

**Each scope axis is rendered only where the board actually consumes it.** `ScopeBar` takes `showRepos` / `showTime` / `showGroupBy`, because a control that silently does nothing is worse than an absent one — it looks like a filter and reads as though the number below it responded to the change.

| Board | Sends | Axes shown |
|---|---|---|
| Delivery Explorer | full scope incl. `groupBy` | all |
| **Productivity, Efficiency** | projects, repos, `from` — **not `groupBy`** | repos + time |
| Top Repos, Team Capacity | scope, `groupBy` forced | repos + time |
| **Velocity, Forecasting, Flow** | `projects` **only** | projects only |

`groupBy` is sent by exactly one hook, `useBatchMetrics`. Productivity and Efficiency go through `scopeParams`, which drops it — so their Group-by toggle changed the URL and nothing else until 2026-08-17 (api/README.md §12 #33). Neither has rows for the axis to split even in principle: Productivity is bucketed by **week** by construction, and Efficiency reports scope-wide percentiles and coverage ratios.

The last row is the substantive one: those three are **Jira-only** metrics. Forecasting is `avg velocity of recent closed sprints ÷ remaining backlog` — sprints, points and backlog items, with no repository dimension to filter by at all; narrowing it by repo would require mapping stories through `pr_implements_story` and would silently drop every unlinked story, making the forecast *wrong* rather than narrower. Time range is equally meaningless there: the forecast samples the **last 3 closed sprints**, not a rolling day window, so a `30d` selector implies control over a sampling decision it doesn't have.

### Honest-math notes
- Velocity/health treat `Done/Closed/Resolved` as done (tenant-tunable constant); committed = items currently attached to the sprint (scope-change history is a follow-up, so mid-sprint additions inflate "committed").
- Forecast is deliberately simple (average velocity ÷ remaining estimated points, average closed-sprint length for dating) and **labels unestimated items as excluded** rather than guessing.

## 5. Role-based assignment

`DASHBOARD_REGISTRY` (backend) = `{key, title, path, description, roles[]}` per dashboard. `/api/dashboards/assignments` filters by the caller's JWT roles; the frontend nav renders only assigned dashboards. Defaults grant all roles everything; the admin assignment editor (per-tenant overrides persisted) is the next increment. RBAC still guards every read endpoint regardless of nav visibility.

## 6. Scope system (unchanged foundation)

URL-synced scope (projects × repos × groupBy × time) with delivery-graph cross-filtering, async searchable pickers, React Query keys derived from the URL. See §3 of the git history version for full detail; the mechanics are implemented in `frontend/src/lib/scope.ts` + `ScopeBar`.

## 7. Performance & scale rules

Server aggregates, client renders; one batch request per table (never N-per-cell); async picker search (never 200 options eagerly); virtualized tables when row counts warrant (TanStack Virtual — Phase next); route-level code-splitting before the bundle passes 250KB gz.

## 8. Ethics & RBAC in the UI

Developer-wise views are labeled activity context; no leaderboards; person-level bug attribution is not surfaced; individual detail only in self-service contexts (AUTH-AND-RBAC §5). Team Capacity in particular renders its roster **alphabetically, never sorted by volume** — it answers "who has no recent activity," not "who did the most."

Tenant admins also see separate **Users & Roles**, **Configuration**, and **Sync Status** navigation items. They are not metric dashboards and are guarded by the same `admin` role as the admin API; all user-role, tenant-configuration, and sync-status reads/writes remain tenant-scoped. Sync Status (`/admin/sync-status`, [docs/api/README.md §7.1](../api/README.md)) shows collector backfill/ingestion progress and live scheduler tick state, broken out **per source** (GitHub and Jira sync and are configured independently — each has its own `syncIntervalMinutes` on the Configuration screen, default every 4 hours) with a recent run-history table per source — operational observability, not a delivery metric.

**Data-trust chrome is first-class, not muted.** Every board surfaces how trustworthy its numbers are: a `computed {timeAgo}` freshness stamp, a per-row Confidence badge (`MetricRowsTable`: `sampleSize === 0` → No data, `< 5` → Low confidence, else → Healthy), and linkage-coverage callouts (e.g. Configuration's "Collecting" / "Not collecting yet" connection status, Sprint boards' code-linkage %, "(unlinked repos)" bucketing on Project Activity). Visual treatment — token, contrast, and typography — is defined in [DESIGN-SYSTEM.md](../development/DESIGN-SYSTEM.md).

There are **two distinct freshness signals and every board carries both**, which is worth stating plainly because they answer different questions and were previously confused for one another:

| Signal | Question it answers | Source |
|---|---|---|
| `Computed {timeAgo}` | When did this *query* run? | the view's own `computedAt` |
| `Data complete through {timeAgo}` | How much of the *source* is actually collected? | `GET /api/dashboards/freshness` → `collectedThroughAt` (api/README.md §9) |

The second is the one that matters with poll-only ingestion on a 4-hour default: a page rendered a second ago can be sitting on hours-old facts. It reports **completeness, not contact** — it previously read `Data as of {lastSyncAt}`, which is when the collector last called the API, and a connection deep in a backfill calls the API every five minutes while being eighty pages behind. The note now renders three distinct states rather than one timestamp: complete through T, *still backfilling* (no completeness exists yet — shown in the warning tone, never as a time), and failing/never-synced (frozen at an unknown age). It is mounted in the shared `ScopeBar`, so the four boards that build their own `FilterBar` instead — Sprint Health, Sprint Risk, Project Activity, Developer Activity — mount `FreshnessNote` explicitly. Sprint Health, Sprint Risk and Developer Activity previously showed **neither** signal.

## 9. Next increments (ordered)

1. **Assignment admin UI** — per-tenant role→dashboard overrides (persisted), replacing the static default registry.
2. **Sprint scope-change history** — committed-at-start snapshots → real commitment reliability + scope-creep on Sprint Health.
3. **Saved views + compare mode** over the scope system.
4. **Jira poller/backfill** so historical sprints/epics arrive without webhooks.
5. **DORA/quality boards** once CI + quality collectors land.
6. Team catalog + team grouping; lineage drill-through UI; exports.

## 10. Change policy

New dashboards, read models, or granularities update this doc in the same change (Documentation-First). Every UI-exposed metric registers in the widget layer; ethics review for anything person-scoped.
