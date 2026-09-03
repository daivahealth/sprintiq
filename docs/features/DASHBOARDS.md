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
| **Project Activity** | `/project-activity` | `dashboards/project-activity` | most-active projects by **commits + LOC across all mapped repos** (delivery graph), Today/7/30/90-day/12-month windows; unlinked repos bucketed honestly |
| **Engineering Activity** | `/engineering-activity/*` | `dashboards/developer-activity/{overview,watchlist,pr-status}` + `dashboards/developer-activity` | **Four subpages under one shell** (§4.4): Overview (team-shaped), Watchlist (people), Developer (one profile), PR Status (review queue). One window, shared across tabs — activity context, never a ranking |
| **Top Repos** | `/top-repos` | `dashboards/metrics` (groupBy=repo, fixed) | Repos ranked by Changed LOC, top 20 by default with a "show all N repos" expansion — repo-level ranking only, never individual |
Top Repos forces its `groupBy` (via `useBatchMetrics`'s explicit override) and hides the Scope Bar's Group-by toggle (`ScopeBar`'s `showGroupBy={false}`) — it is a dedicated single-purpose screen, not a configurable view like Delivery Explorer.

**Team Capacity was retired into Engineering Activity §Watchlist on 2026-08-25.** It answered "who has no PR activity in this window" over a `groupBy=developer` metrics read. The Watchlist answers the same question over a strictly wider signal set — commits, PRs opened, merges and reviews together — so keeping both meant two routes, two nav entries and two different answers to one question, differing only in which signals each happened to look at. `/team-capacity` now redirects to `/engineering-activity/watchlist`; the registry entry is gone.

### 4.1 Two boards, one person: stating each board's denominator

Delivery Explorer (`groupBy=developer`) and Engineering Activity both answer "what did this person do", and they will not agree — by design. They must therefore each say what they count, because an unexplained gap between them reads as a bug in the data:

| | Delivery Explorer, grouped by developer | Engineering Activity |
|---|---|---|
| Unit | pull requests | commits |
| Included | **merged only** | commits landed in the window; PRs in **all states** |
| Windowed on | `mergedAt` | `committedAt` (commits) / `openedAt` (PRs) |
| Window edges | rolling UTC (`now − days`) | IST calendar-aligned (`istWindowFloor`) |
| LOC means | PR diff size | commit diff size |

PR diff size is not the sum of its commits (rebases and merge bases see to that), so the two LOC figures are different measurements, not a reconciliation to chase. Engineering Activity reports `prsMerged` beside `prsAuthored` so the PR-count difference is visible on the page rather than inferred by comparing screens.

**Neither board may rank individuals.** Delivery Explorer sorts by Changed LOC descending for every grouping *except* developer, where rows are alphabetical — sorting people by lines changed is precisely the leaderboard CLAUDE.md forbids and that Team Capacity is deliberately built to avoid. LOC is change-volume context, never a productivity score.

### 4.1.1 One definition of "when"

Every window and every bucket in the app is **IST calendar-aligned**, via `istWindowFloor` / `istDateKey` / `istWeekKey` (backend `common/time.ts`, mirrored in `frontend/src/lib/utils.ts`).

This was three conventions until they were unified: the Scope Bar sent a rolling `now − days×86400000`, the activity boards bucketed by IST day, and Productivity bucketed weeks on the **UTC** Sunday. (The activity boards' own `windowFrom` kept computing the retired rolling form for `FreshnessNote` long after this was written — so the note judged a range up to a day wider than the one the board had actually queried. It now calls the shared `istWindowFloor` like everything else.) "Last 7 days" therefore denoted three different ranges depending on the board, differing by up to a full day at each edge, and a PR merged after 18:30 IST was filed under tomorrow on one screen and today on another. Adding a new window or bucket means reusing these helpers, not writing another date expression.

The Engineering Activity section additionally accepts a **custom range**: two IST calendar dates, inclusive at both ends, resolved by `istDayStart` / `istDayEnd` / `istDaySpan` (backend `common/time.ts`, mirrored in `frontend/src/lib/utils.ts`). Inclusive at both ends is what keeps it the same definition — a hand-picked seven days and the "7 days" preset resolve to the same instants and return the same numbers. The same reason `istDayAxis` takes the day to end on: a chart hardcoded to today drew a closed April–June range as an unbroken row of zeros.

### 4.1.2 Sprints Jira still calls active

Jira never closes a sprint by itself — `state` is whatever someone last set. A team that stops using a board leaves its final sprint `active` indefinitely; on the reference tenant one had been "active" for over four years and rendered as a live card at 100% elapsed, 0 days remaining, pace "behind", permanently, beside the sprint actually running.

An active sprint whose `endAt` passed more than **`STALE_ACTIVE_SPRINT_GRACE_DAYS` (14)** ago is therefore treated as stale: excluded from the ranked active cards on Sprint Health and Sprint Risk, and reported separately with how far past its end it is. Excluded because it is 100% elapsed by definition, so pace-ranking always floats it above the sprint that can still be acted on; **reported rather than hidden** because the sprint is real and someone needs to close it — hiding it would trade a misleading card for a silent omission. A short overrun is ordinary and stays in the normal cards, which is what the grace period is for.

Unstarted (`future`) sprints are likewise kept out of the sprint picker, which requests `state=active,closed`: they have no dates, no transitions and nothing delivered, so every figure these boards compute is empty for one. Note also that sprint ordering must specify `nulls: 'last'` — Postgres sorts `NULL` **first** on a descending sort, so a dateless future sprint otherwise outranked every real one and arrived at the top of the picker.

### 4.1.3 Daily activity (who committed, day by day)

Superseded as a standalone section on 2026-08-25 — this content now lives inside §Overview's commit timeline as its drill-down (§4.4.1). The rules below survive the move unchanged and are still binding; only the presentation changed, from a scrolling text log beside a chart of the same data to one chart whose bars open.

The data comes from `GET /api/dashboards/developer-activity/overview?window=` (previously `/daily`, which is retained for compatibility): one entry per IST day, newest first, with the day's **total commit count** and **every developer who committed** that day, each with their count. Attribution runs through the identity map in bulk (`DeveloperIdentityService.attributionIndex`) so unverified-email commits count under the right person; commits matching no identity appear as **"+N unattributed"** per day — disclosed, never dropped or guessed. A truncated read says so on screen instead of under-reporting silently.

**An empty window says which window it was empty for.** The selectable ranges are Today / 7 / 30 / 90 days / 12 months (`ACTIVITY_WINDOWS`); the 30-day ceiling they used to stop at was a limit on what the board could show rather than a cost control, and it made a whole class of repository unreachable. `athmahealth/nh-website` is the case that surfaced it — 12 commits between 20 Jun and 21 Jul, dormant since — so every developer on it read as "0 commits" on every available range, and a review of the developer roster proposed removing them as inactive. That is the failure a missing range becomes: absence of a window presenting as absence of work. An empty result now names the interval it measured (`No commits between 27 Jul and 25 Aug`) and offers the next range up, degrading to a plain statement at the widest one. The interval is rendered from the server's `windowDays` — the range actually measured — not from the selected key, because an unrecognised window falls back to 30 days rather than 400ing so a frontend can ship ahead of its backend, and echoing the requested key would label 30 days of data as 90.

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

- **Engineering Activity** names the identities behind its figures. When commits were recovered through a non-login identity it says so; when the total is zero and nothing was recovered, it says the likely cause rather than presenting the zero as a finding.
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

### 4.4 Engineering Activity: four subpages, one dataset

**Renamed from "Developer Activity" on 2026-08-31, display and route only.** The API paths stay `/api/dashboards/developer-activity/*`, the registry `key`s stay `developer-activity*`, and the frontend directory, service and component keep their old names. That divergence is deliberate, not an unfinished rename: the frontend and backend deploy separately here, so renaming the endpoints would 404 every panel in the section on a skewed deploy, and the registry keys are role-assignment identifiers that per-tenant overrides are stored against. `/developer-activity/*` redirects to the new route, preserving the subpage **and** the query string — the range lives in the URL, so a redirect that dropped it would show a shared link real numbers for a range nobody asked for. The **Developer** subpage, the `?developer=` endpoint and `DeveloperActivityView` keep the word *developer* because they genuinely describe one person, not the section.

Engineering Activity is one section at `/engineering-activity/*` with four subpages — Overview, Watchlist, Developer, PR Status — under a shell that owns the title, the tab strip and **the window**. The window lives in the URL (`?window=`) and is shared across tabs, so switching from Overview to PR Status keeps the range you were reading and there is exactly **one** `FreshnessNote` on screen rather than four boards each vouching for their own copy of the same range. The sidebar keeps one entry that expands to its four children while the section is active (`DASHBOARD_REGISTRY[].children`), rather than four permanent peer entries.

**The window is a range.** Alongside the five presets the section offers a **custom** interval — any two IST dates — because every preset ends today, so a closed past period cannot be looked at in isolation: the range containing a repository's active June also contains the dormant months that dilute it. Presets remain unchanged on the wire (`?window=week`); a custom range travels as `?window=custom&from=&to=` and is carried across tab switches like the preset is. Three figures on these pages are **current state that cannot be time-travelled** — Jira assignment, the open-PR queue, and live exclusions — and on a range ending in the past each says so on screen rather than passing as historical.

**The organising rule is that each subpage owns exactly one question, and no number appears on two of them.** The design this replaced failed that test in four places, and each fix is load-bearing rather than cosmetic:

| Duplication | Resolution |
|---|---|
| Overview's roster table (status + last signal) *was* the Watchlist, laid out differently | Overview drops the roster entirely and becomes team-shaped. Watchlist owns people. |
| A commit chart **and** a text log of who committed each day — the same data drawn twice | One chart whose bars open to that day's contributors (§4.4.1) |
| "Needs a check-in: 4" on Overview and "No tracked activity: 4" on the Watchlist | One number, on the Watchlist; Overview links to it |
| Developer Detail's "commits with a ticket" and "commits without a ticket" tables | One list; linkage is a column, not a second table |

Two things the mockups asked for are **not built, because the data does not exist**, and inventing them would have been a guess presented as a fact:

- **"Pending on them"** (which reviewer a PR is blocked on) needs GitHub's `requested_reviewers`, which the collector does not fetch and `code_pull_request` has no column for. PR Status reports what *is* known — how long the change has waited and whether anyone has reviewed it at all.
- **Auto-exclusion for approved leave / recent joiners** needs an HR feed SprintIQ does not have. Replaced by an explicit admin-entered exclusion (§4.4.2).

#### 4.4.1 Overview — team-shaped

The **active-developer roster**, four tiles (commits · developers with a signal `N of M` · PRs opened, `N` merged · committing without assigned work), the commit timeline, and a **data-health card** carrying both coverage figures.

**The roster is the names behind the tile above it** (added 2026-09-02). `activeDevelopers[]` is the union of commit authors and PR authors in the window — *exactly* the set `totals.developersWithSignal` counts, computed from it, so the list and the count can never disagree about the same window. Each row carries that person's commits, PRs opened and PRs merged, and links to their Developer page. Zero is rendered as `0`, never as a blank: a PR-only contributor belongs on the roster and an empty cell reads as missing data.

**It is a roster, not a league table.** The API returns it alphabetically; the **"Most commits"** toggle is the reader's explicit act and is never persisted — the same treatment, for the same reason, as the timeline drill-down (§4.1.3). No positions, no totals row, no default that orders people by output. CLAUDE.md's no-ranking rule is what this is answering to, and the shape of the answer is: sorting is available because a reader asked for it, and never applied on their behalf.

**This is the one roster Overview carries, and it is deliberately not the Watchlist's.** An earlier design rendered the Watchlist's roster here as well, which made two screens out of one dataset; that removal stands. The two answer different questions: the Watchlist asks *who to go ask about* (recency buckets, assignment gaps), this asks *who was working*. Anything about attention or absence belongs there, not here.

**The timeline is one widget doing the work of two.** Each bar is an IST day; selecting one opens that day's contributors inline, each linking to their Developer page. This is where §4.1.3's daily log went, and every rule from it survives: alphabetical ordering by default, the recorded owner-requested **"Most commits"** toggle as the reader's explicit act only, `+N unattributed` per day, and the empty-window note that names the interval it measured (from the server's `windowDays`, never the requested key) and offers the next range up.

**Every link out of this page carries the range.** The roster and the timeline drill-down both build `?developer=…` *through the current range params*. A bare `?developer=` drops the window and `parseRange` falls back to the default, landing the reader on real numbers for a range they never chose — the one failure this section exists to prevent. The drill-down did exactly that until 2026-09-02.

**No project breakdown.** Projects are Project Activity's.

#### 4.4.2 Watchlist — people, and the two lenses on them

The one page in the platform that names individuals for attention, so its framing is part of its specification, not decoration around it. A guardrail banner is the first element on the page, and it states plainly that this is a prompt to ask a question, that absence of a tracked signal is not absence of work (pairing, design, support and review outside GitHub all leave nothing here), and that individual cases go to the person's manager in conversation.

**Two orthogonal lenses, deliberately not merged:**

1. **Recency buckets** — Active / Quiet / No tracked activity, over commits, PRs opened, merges and reviews together. Each column header states its exact threshold; a bucket whose rule the reader has to guess is a label they will fill in themselves. Cards carry the last signal's **type and when**, and deliberately **no commit counts** — counts invite the comparison between two named people this page must not support, and recency is the question being asked.
2. **Committing without assigned work** — landed commits in the window, no open Jira item assigned. This is the planning gap: work the plan cannot see. Separate from the buckets because the two are independent — an *Active* developer with nothing assigned is exactly the case worth surfacing, and folding assignment into the buckets would bury them.

**Thresholds are in working days (Mon–Fri).** On calendar days a "7 day" rule spends two of them on a weekend nobody was expected to commit through, and the whole roster reads quieter every Monday morning. Public holidays are **not** modelled — SprintIQ has no holiday calendar and inventing one per tenant would be a guess — so a team returning from one reads slightly quieter than it was, which the page's framing is built to tolerate. Boundaries belong to the kinder bucket: being an hour over a threshold is not evidence about a person.

**Recency is measured as of the range end, not as of today.** With a preset those are the same instant. With a custom range ending in the past they are not, and measuring against today would put two timeframes on one page — April's commits beside "quiet as of this morning". So the whole page answers for one moment: the signal scan is bounded above at the range end (`signalScanRange`) as well as below, and `bucketFor` is given that same moment. A developer who went quiet in May and returned in August therefore reads as quiet on an April–June board, which is what was true then.

**Exclusions are an explicit human statement, never an inference.** `watchlist_exclusion` rows are entered by an admin (`PUT /api/dashboards/watchlist-exclusions/{developer}`), carry a **reason from a closed set**, **who entered them**, and a **mandatory expiry capped at 180 days** — an exclusion with no end date is how someone drops off the roster permanently without anyone deciding to. An exclusion suppresses exactly one thing: appearing in an attention bucket. The developer keeps counting in every commit, PR and metric figure, and the page **publishes the exclusion list with reasons** rather than applying it silently, because a filtered roster whose filter is invisible is how a review loses the person it should have surfaced. With none configured the page says so — never that leave and start dates were checked.

#### 4.4.3 Developer — one person, evidence-first

The profile from the old board (commits, lines, PRs opened/merged, commits-per-day, repos, recent commits, and the identity notes) plus **reviews given** and **assigned Jira work**. Two removals:

- **The second commit table** ("without a linked ticket") was the same list split by one attribute. One list; linkage is a column.
- **Per-person "average time to first review"** is gone. Review latency is a property of the team's review capacity, not of the person waiting on it; attaching it to an individual converts a queue signal into a personal score. The team figure is Efficiency's.

#### 4.4.4 PR Status — the review queue

Tiles (open · waiting past the threshold · **never reviewed** · reviews given, bots excluded), the waiting queue oldest-first, and review load A–Z.

**It reports no cycle-time percentiles.** Those are Efficiency's, over a merged-only denominator; restating them here over a different one puts two numbers for one concept on two screens and invites the reader to reconcile a gap that exists by design (§4.1). The page links across instead.

**Open PRs are not windowed.** A change opened four months ago and still unreviewed is the most actionable row the page can carry, and a `from` filter is precisely what would hide it. Reviews given and PRs raised *do* use the window. On a custom range ending in the past, the queue is still today's — open PRs are current state with no collected history — and the page says so rather than letting an as-of-today queue pass as historical.

**Which is disclosed beside the tiles, not at the foot of the page.** Three of the four tiles and the whole queue ignore the window; only *reviews given* and *review load* respond to it. Changing the range and watching most of the page sit still reads as a broken filter, so the explanation belongs where that confusion happens — directly under the tiles — rather than below two tables (moved 2026-09-03; the note existed, in the wrong place). For the same reason the *reviews given* hint carries **"this window"** alongside any bot-exclusion count instead of being replaced by it: it is the page's only per-tile marker of what the filter touches, and swapping it out on tenants that have bot reviews removed it from almost everyone.

**Ordering is by how long the change has waited** — a property of the pull request, not of its author. The per-developer table is alphabetical, and reports **oldest PR still waiting** rather than an average: a mean over two PRs describes neither of them.

**`reviewsFetchedAt` gates the unreviewed count.** An open PR whose review timeline was never fetched is excluded and disclosed, not counted as unreviewed — "never asked" and "never reviewed" are the same absence of `code_pr_review` rows and opposite findings, and conflating them reports collection lag as a review failure.

#### 4.4.5 The Jira assignee bridge, and why its coverage is always on screen

Assignment answers ("who is committing with nothing assigned") require mapping a **Jira assignee to a canonical developer**, and until 2026-08-25 no such mapping existed: `DeveloperIdentityService` had `sourceSystem` hardcoded to `github`. The Jira arm (`resolveJiraAssignees`, run each correlation sweep **after** the GitHub pass, whose canonical ids it matches into) fills that gap — and it is the weakest link in this section, which is why it is documented rather than assumed.

**How strong the bridge is depends on one Jira setting.** Where the instance discloses the assignee's Atlassian email, matching is `email_exact` against an address the person already commits under — a fact, not a guess, and the reason people who commit under a corporate address are reachable at all. Where it doesn't, the ladder falls back to normalized display name and account reference, both recorded as `name_normalized`. Jira Cloud withholds `emailAddress` unless user-profile visibility permits it, so the weaker path is the common one until an admin opens that setting and `POST /admin/configurations/jira/reconcile-assignee-emails` backfills. The full ladder, its guards (machine addresses, shared mailboxes) and the reconciler's assignee-keyed cost model are in DATA-MODEL.md §3.1.

Ambiguity on the name rungs (two colleagues normalizing to one key) is **refused and orphaned**, never resolved by coin flip: guessing here would assign one person's tickets to another *and* report the wronged party as working off-plan.

**Coverage is measured over developers, not over Jira assignees** — and getting that wrong cost a wasted investigation, so it is worth stating plainly (api/README.md §12 #47).

The assignee-side ratio (`matched / observed`) was published first and read as *"how well the bridge works"*. It is nothing of the kind. On the reference tenant it said **41%**, which sent remediation toward collecting Atlassian emails — until a diagnostic showed **127 of the 128 unmatched assignees have no route to GitHub by any token**. They are QA, BA, PM and support staff who hold tickets and never commit: there is no GitHub entity to link them to, and email matching would have recovered exactly one person. That ratio measures **org composition**, not matching quality.

The figure the boards show is `developersLinked / developersInWindow` over the people who actually committed. Same tenant, same data: **97.7% (7 days)**, **94.2% (30 days)**.

Two corrections follow from it:

- **Automation is excluded from every head-count.** `dependabot[bot]`, `Copilot` and `github-actions[bot]` were being counted as developers missing a Jira account. `isBotDeveloper` keeps them out of the coverage denominator *and* out of the Watchlist roster — where a bot would eventually have surfaced under "no tracked activity", inviting someone to go check on a robot. Their commits still count in commit and LOC totals; this excludes them from counts of *people*, not from the work.
- **The unlinked are named, not just counted.** A percentage tells a reader to distrust the whole list; four names tell them which rows to distrust, and are short enough to act on.

**Every assignment figure ships beside `assigneeCoverage`, and null is never rendered as zero.** An unmatched assignee and a developer with nothing assigned are the same absence on screen and opposite findings in fact — a data gap versus the finding itself. So: `hasAssignedWork` is `null` (not `false`) for anyone the bridge missed; the "committing without assigned work" list is computed only over matched people; the Overview tile renders `—` rather than `0` when nothing matched at all; the Developer page distinguishes "no assignee matched" from "no open items"; and the Watchlist prints the unmatched count beside the list with the instruction to check it in conversation before acting.

The same caveat governs a range that ends in the past. Jira assignment is read as it stands **now**; we keep no assignment history. So on a historical range the planning gap would be comparing that range's commits against today's Jira board — two moments, one figure. The affected panels carry a note saying which moment they describe (`CurrentLensNote`), on the same principle as the coverage figure itself: the number is shown, and what it can support is stated with it.

**Jira rows share a table with commit attribution, so every commit-facing read is now scoped.** `aliasesFor`, `attributionIndex`, `listDevelopers` and `attributionCoverage` all filter `sourceSystem: 'github'`. Without that, a Jira `accountId` would enter `AttributionIndex.byLogin` — the map commit attribution is looked up in — and would widen a developer's commit query with an identifier that means nothing to git. There is a test asserting each of the four stays scoped.

#### 4.4.6 One name per person, and the unlinked shown with candidates

**A developer had as many names as systems they appear in.** The same human read as `Ram-Kumar_athma` in the picker, `RamKumar AK` on a Jira-derived figure, and `saravanakumar_athma` — an EMU shortcode presented as a name — wherever git `user.name` won. `attributionIndex().displayNames` now resolves one name through a ladder ordered by how curated each source is, measured across the reference tenant's 89 linked developers:

| Rung | Source | Why here |
|---|---|---|
| 1 | **Jira display name** | Human-entered in the system that tracks people. Complete for every linked developer, correctly spaced ("Gnanesh Gowda NS", "Pavan Kumar Reddy Gaddam"). |
| 2 | **GitHub login, de-EMU'd** | `Ram-Kumar_athma` → "Ram Kumar". Equally clean, but 14 of 111 GitHub entities have no login. |
| 3 | **git author name** | Whatever was in a config file — a proper name, or `animesh.khatua`, or the login itself (`Jana-M_athma`), so it is rendered through the login treatment when it carries a shortcode. |
| 4 | canonical id | Always something. |

**Not derived from the org email**, despite that being the natural identity key: local parts mangle the label. `vijaykumar.yadav01@` gives "Vijaykumar Yadav01"; `sivaganeshsagar.yedumalla@` loses every word boundary. An email is a good key and a poor name.

The canonical **id** is untouched — only what is rendered changes, so links and bookmarked `?developer=` URLs keep resolving.

**Unlinked developers are listed with the names that might be them.** Anyone who committed in the window with no Jira account matched appears on the Watchlist with up to three candidates, drawn from two pools because the tenant has two distinct failure modes: *Jira assignees* (for a genuinely unlinked person) and *other GitHub developers* (for a stray fragment — `Junaid Haneef`, committing from a personal Gmail, belongs to the already-linked `Mohammed-Junaid-Haneef_athma`).

**Both signals require containment, not overlap, and that is the whole safety argument:**

```
Junaid Haneef      vs Mohammed Junaid Haneef → {junaid,haneef} ⊂ {mohammed,junaid,haneef}  ✓
Vijay Kumar Yadav  vs Sanjay Kumar Yadav     → shares {kumar,yadav}, neither contains the other  ✗
```

Plain overlap scores those two identically at 2/3. That is precisely how one colleague's work gets credited to another, and it is why the matcher that is *allowed to merge* (`resolveJiraIdentity`) never uses resemblance at all. A `substring` rung catches compacted spellings token comparison misses (`Ram Kumar` inside `RamKumar AK`), floored at 5 characters so a short name cannot match half the roster.

**Nothing here writes.** Suggestions are displayed for a person to recognise their colleague — a judgement the matcher deliberately refuses to make, since no threshold makes `Junaid Haneef` → `Mohammed Junaid Haneef` safe to apply automatically. Where several names fit, **all** are shown: that is what stops a reader treating a coin flip as an answer. Confirming a suggestion is a separate, deliberate action that does not exist yet.

Measured on the reference tenant, all four unlinked developers receive their correct candidate:

| Unlinked | Suggested | Basis |
|---|---|---|
| Junaid Haneef | Mohammed Junaid Haneef | token subset |
| nithin | Nithin N | token subset |
| saravanakumar | Saravanakumar N | token subset |
| Ram Kumar | RamKumar AK | substring |

#### 4.4.7 Accounts that are not people

Three kinds of entity reach the identity map without a colleague behind them, and each one landed in the Watchlist's attention buckets before it was handled. The failure is the same every time — the board asks someone to go check on a person who does not exist — but the causes are different enough that they need separate treatment:

| Kind | Example | Treatment |
|---|---|---|
| **Automation** | `dependabot[bot]`, `Copilot`, `github-actions[bot]` | Excluded from buckets and head-counts (§4.4.5) |
| **Deprovisioned accounts** | `1a824967e10493200d5a7ee2d91b87_athma` | Excluded from buckets, **listed separately** |
| **Misconfigured git** | `379031`, from `a379031@CORPLPM000257.local` | Left in the roster — a real person, odd config |

**Deprovisioned accounts are reported, not filtered.** When an Enterprise Managed User is removed, GitHub replaces the readable login with a long hex string and keeps the enterprise shortcode. On the reference tenant there are **five**, and they were sorting to the very top of "no tracked activity" — 22 developers in that bucket, of whom 5 were decommissioned accounts. One carries **159 pull requests**; another 83.

That PR count is the reason they are listed rather than dropped. An account with 159 merged pull requests behind it did real delivery work whose history someone may still want attributed, and a roster that quietly removes a whole category of account is one nobody can audit — the same principle that makes the exclusion list (§4.4.2) visible rather than silent. They appear in an **Inactive / deprovisioned accounts** card stating what they are, with the note that their commits and pull requests still count in every total: this removes them from head-counts of *people*, not from the work.

**Detection is deliberately narrow.** The predicate is 20 or more characters of *pure* hex before the trailing shortcode. `deadbeef` is a login someone could have chosen; `cafe1234_athma` likewise; `379031` is an employee number belonging to a real developer whose git config points at a laptop hostname. All three stay in the roster. The asymmetry is intentional — a false negative costs one odd-looking row, while a false positive quietly removes a real person from a board whose entire purpose is noticing people, so the rule errs toward keeping them.

**Misconfigured git is a person, not a ghost.** `379031` commits as `a379031@CORPLPM000257.local` — a machine hostname, not a mail domain — and stays in the buckets, because there is someone behind it. It resolves itself the moment they set `user.email` to their corporate address, which also makes their commits attributable (§4.2). Naming it here so it is not mistaken for the deprovisioned case it superficially resembles.

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
| `Data complete through {timeAgo}` | Is the range THIS board shows actually collected? | `GET /api/dashboards/freshness` → `collectedBackTo` / `collectedThroughAt` (api/README.md §9) |

The second is the one that matters with poll-only ingestion on a 4-hour default: a page rendered a second ago can be sitting on hours-old facts. It reports **completeness, not contact** — it previously read `Data as of {lastSyncAt}`, which is when the collector last called the API, and a connection deep in a backfill calls the API every five minutes while being eighty pages behind. The note renders distinct states rather than one timestamp: complete through T, *still backfilling* (no completeness yet), and failing/never-synced (frozen at an unknown age).

**It judges the window on screen, not the whole dataset.** Collection is a range — `[collectedBackTo, collectedThroughAt]` — and a board showing `[from, now]` is complete iff `collectedBackTo <= from`. So a "last 7 days" board over a complete last 7 days says nothing at all, even mid-way through a 12-month backfill; only a board whose window genuinely reaches past the collected history reports a shortfall, and it names the date that history starts. `ScopeBar` passes its `from` (and none when `showTime={false}`); Project and Engineering Activity pass their own window toggle's start; Sprint Health and Sprint Risk have no time range and get the plain statement. This matters beyond tidiness: a warning that fires on correct numbers for days teaches people to ignore the warnings that aren't. It is mounted in the shared `ScopeBar`, so the four boards that build their own `FilterBar` instead — Sprint Health, Sprint Risk, Project Activity, Engineering Activity — mount `FreshnessNote` explicitly. Sprint Health, Sprint Risk and Engineering Activity previously showed **neither** signal.

## 9. Next increments (ordered)

1. **Assignment admin UI** — per-tenant role→dashboard overrides (persisted), replacing the static default registry.
2. **Sprint scope-change history** — committed-at-start snapshots → real commitment reliability + scope-creep on Sprint Health.
3. **Saved views + compare mode** over the scope system.
4. **Jira poller/backfill** so historical sprints/epics arrive without webhooks.
5. **DORA/quality boards** once CI + quality collectors land.
6. Team catalog + team grouping; lineage drill-through UI; exports.

## 10. Change policy

New dashboards, read models, or granularities update this doc in the same change (Documentation-First). Every UI-exposed metric registers in the widget layer; ethics review for anything person-scoped.
