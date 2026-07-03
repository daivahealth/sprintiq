# Frontend & Dashboards Plan

Canonical frontend/dashboard spec for SprintIQ at real scale: **~200 repositories, ~60 projects**, many concurrent sprints — **common, metric-centric dashboards** (not persona pages) with **role-based assignment**, **bi-directional Jira↔GitHub tracking**, and **work-item detailing at every granularity** (story / sub-task / bug / epic / developer / release / sprint).

> Context: [PRODUCT-ARCHITECTURE.md §9](../architecture/PRODUCT-ARCHITECTURE.md) (KPI inventories — used as *content* input for widgets, not as page structure), [METRICS.md](METRICS.md) (metric catalog), [AUTH-AND-RBAC.md](../security/AUTH-AND-RBAC.md) (roles, metric ethics).

---

## 1. Product decisions (settled)

1. **Common dashboards, not persona pages.** Dashboards are named after *what they measure* — Sprint Health, Sprint Risk, Velocity, Forecasting, Productivity, Efficiency, Delivery Explorer. Personas are served by **assigning dashboards to roles**, not by bespoke persona pages.
2. **Role-based assignment.** Each dashboard carries a role list; `GET /api/dashboards/assignments` returns the dashboards for the current user's roles and drives the nav. Default: all dashboards → all roles; per-tenant admin-configurable assignment is the follow-up (admin UI over the same registry).
3. **Bi-directional Jira↔GitHub tracking everywhere.** Every dashboard exposes both directions of the correlation graph: work items → their linked PRs (Jira→GitHub) and PRs → their work items (GitHub→Jira), with coverage percentages and orphans surfaced.
4. **Detailing at every granularity** — the backend read models answer story-wise, sub-task-wise, bug-wise, epic-wise, developer-wise, release-wise, sprint-wise questions (see §3).
5. Numbers are computed server-side from persisted facts + correlation links; missing data renders as missing (never fabricated), with sample size/freshness shown.

---

## 2. Current state (implemented)

- **Data model (planning):** full Jira hierarchy — epics and sub-tasks are typed work-item rows (`type` ∈ story|bug|task|spike|subtask|epic) with `epicKey`/`parentKey`; `Sprint` and `Release` (fixVersion) entities; sprint/release/assignee/priority/resolvedAt on every item. Jira collector parses parent/epic, sprint, fixVersions, assignee, resolutiondate from webhooks.
- **Insight read models (BC-8 `InsightsService`):** sprint-health, sprint-risk, velocity (per closed sprint), forecast (avg velocity vs open backlog), productivity (weekly items/points/PRs/LOC), efficiency (PR + story cycle times, bi-directional traceability), work-items detail (any granularity, each row with its linked PRs).
- **BFF endpoints:** `/api/dashboards/{assignments, work-items, sprint-health, sprint-risk, velocity, forecast, productivity, efficiency, metrics}`, catalogs `/api/catalog/{projects, repos, sprints, epics, releases}`.
- **Frontend:** URL-synced Scope Bar (projects × repos × time × groupBy, delivery-graph cross-filtering), role-driven nav from `/assignments`, and seven dashboards: Delivery Explorer + the six common boards.
- **Still missing:** per-tenant assignment admin UI, saved views, team catalog/grouping, lineage drill-through UI, DORA/quality boards (need CI/quality collectors), Jira poller/backfill, sprint scope-change (committed-at-start) history.

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
| **Delivery Explorer** | `/` | `dashboards/metrics` | any metric × scope × groupBy (repo/project/developer/day) table |
| **Sprint Health** | `/sprint-health` | `dashboards/sprint-health/active` + `dashboards/sprint-health` | **multi-project default: one card per concurrent active sprint** (each project runs its own lifecycle), ranked worst-pace-first with **cadence-normalized pace** (completion % vs elapsed % of that sprint's own window → on-track/at-risk/behind); click to drill into committed vs completed, code linkage, by-type progress |
| **Sprint Risk** | `/sprint-risk` | `dashboards/sprint-risk` | open items **without linked code** (at-risk pts), open bugs, unestimated work — each row with its PRs |
| **Velocity** | `/velocity` | `dashboards/velocity` | completed vs committed points per closed sprint |
| **Forecasting** | `/forecast` | `dashboards/forecast` | avg velocity (last 3 closed) vs remaining backlog → sprints needed + projected date; unestimated items flagged |
| **Productivity** | `/productivity` | `dashboards/productivity` | weekly throughput: items + points (Jira) and merged PRs + LOC (GitHub) — team-level |
| **Efficiency** | `/efficiency` | `dashboards/efficiency` | PR cycle p50/p85, story cycle p50/p85, **traceability both directions** |
| **Project Activity** | `/project-activity` | `dashboards/project-activity` | most-active projects by **commits + LOC across all mapped repos** (delivery graph), day/week/month windows; unlinked repos bucketed honestly |
| **Developer Activity** | `/developer-activity` | `dashboards/developer-activity` | GitHub-style per-developer profile: commit history (sha/±LOC), repos committed to, lines committed, commits-per-day, PRs authored, **active projects** via the graph — activity context, never a ranking |

All boards sit on the **Scope Bar** (projects/repos/time, URL-synced, graph cross-filtered); sprint boards add a sprint picker (auto-selects the active sprint in scope).

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

Developer-wise views are labeled activity context; no leaderboards; person-level bug attribution is not surfaced; individual detail only in self-service contexts (AUTH-AND-RBAC §5).

## 9. Next increments (ordered)

1. **Assignment admin UI** — per-tenant role→dashboard overrides (persisted), replacing the static default registry.
2. **Sprint scope-change history** — committed-at-start snapshots → real commitment reliability + scope-creep on Sprint Health.
3. **Saved views + compare mode** over the scope system.
4. **Jira poller/backfill** so historical sprints/epics arrive without webhooks.
5. **DORA/quality boards** once CI + quality collectors land.
6. Team catalog + team grouping; lineage drill-through UI; exports.

## 10. Change policy

New dashboards, read models, or granularities update this doc in the same change (Documentation-First). Every UI-exposed metric registers in the widget layer; ethics review for anything person-scoped.
