# Frontend & Dashboards Plan

Comprehensive plan for the SprintIQ frontend at real scale: **~200 repositories, ~60 projects**, many teams and concurrent sprints — with the ability to view **any combination** of metric × scope × entities × grouping × time.

> Context: [PRODUCT-ARCHITECTURE.md §9](../architecture/PRODUCT-ARCHITECTURE.md) (per-persona dashboard designs), [METRICS.md](METRICS.md) (metric catalog + scopes), [AUTH-AND-RBAC.md](../security/AUTH-AND-RBAC.md) (roles, metric ethics). This doc is the canonical frontend/dashboard spec; the per-persona KPI lists in the architecture doc remain authoritative for *content*, this doc defines *how the frontend delivers them at scale*.

---

## 1. Goals & scale constraints

| Constraint | Design consequence |
|---|---|
| ~200 repos, ~60 projects, N teams, many concurrent sprints | No "page per entity" navigation as primary UX. **Explorers** (virtualized tables) + **searchable async pickers**, never 200-item dropdowns rendered eagerly. |
| "Display all combinations of data" | A first-class **Scope System**: every dashboard reads from one composable scope (projects × repos × teams × sprints × time), not per-page ad-hoc filters. |
| Numbers must be trustworthy | Every widget carries **metric health, freshness, sample size, lineage** (frontend rule — already established in the PR-cycle-time card). |
| Multi-tenant, RBAC | Scope options and pages are filtered by role; individual-level views obey the metric-ethics rules (team-level by default). |
| Metrics arrive incrementally (only `pr_cycle_time` exists today) | A **widget registry keyed by the metric catalog** — new backend metrics light up in the UI without page rewrites. |

**Non-goals:** building all persona dashboards at once; client-side aggregation over raw events (aggregation is the Metrics Engine's job — the frontend renders server-computed values).

---

## 2. Current state (baseline)

- Pages: Login (email-only), one Delivery dashboard with a **free-text repo input** calling `GET /api/dashboards/pr-cycle-time?repo=…`.
- Stack: Vite + React 18 + TS + Tailwind, React Query (server state), Zustand (auth), React Router.
- BFF: `auth/login`, `auth/me`, `admin/*`, one metric endpoint. **No catalog endpoints, no batch/aggregate endpoints, no saved views.**

The plan below is a bridge from this baseline to the full system, in phases that each ship something usable.

---

## 3. The Scope System — the "all combinations" engine

The heart of the plan. One mental model used everywhere:

```
        ┌──────────────────────── Global Scope Bar (persistent, URL-synced) ───────────────────────┐
        │  Projects [multi ▾search]  Repos [multi ▾search]  Teams [▾]  Sprint [▾]  ⏱ Time range      │
        └───────────────┬────────────────────────────────────────────────────────────────────────────┘
                        │  scope = { projects[], repos[], teams[], sprintId?, from, to }
                        ▼
   every widget/table = f(metricKey, scope, groupBy)          groupBy ∈ {repo, project, team, sprint, none}
```

### 3.1 Dimensions & combinations

| Dimension | Cardinality | Picker behavior |
|---|---|---|
| Project | ~60 | Searchable multi-select; "All projects" default; type-ahead, checkbox list, select-all-filtered |
| Repository | ~200 | **Async searchable** multi-select (server-side search + pagination); cross-filtered by selected projects |
| Team | 10s | Searchable multi-select |
| Sprint | many concurrent | Contextual to selected project(s); "current sprint(s)" smart default |
| Time | continuous | Presets (7/14/30/90d, sprint, quarter) + custom range |
| Group by | 5 | repo / project / team / sprint / none (aggregate) |
| Metric | ~40+ (catalog) | Widget-defined or user-selected in Explorer |

**Any combination** = `metric × entity selection × groupBy × time`. Examples the system must answer without new pages:
- *PR cycle time for repos linked to Projects A, B over last sprint, grouped by repo* → Explorer table.
- *Velocity across all 60 projects this quarter, grouped by project* → Portfolio table.
- *Review latency for Team X's 14 repos vs Team Y's, last 30d* → Compare view.

### 3.2 Cross-filtering via the delivery graph (differentiator)

Selecting projects narrows the repo picker to **repos actually linked to those projects** — computed from `correlation_link` (repos whose PRs implement those projects' stories). The moat powers the UX: SprintIQ *knows* which of the 200 repos belong to which of the 60 projects without manual mapping. Unlinked repos remain reachable via "show all".

### 3.3 URL as source of truth

The scope serializes to the URL (`?projects=PAY,OPS&repos=…&from=…&groupBy=repo`). Consequences:
- **Shareable**: paste a link, teammate sees the same view (their RBAC permitting).
- **Back/forward** works; refresh-safe.
- React Query cache keys derive from the same serialized scope → correct caching for free.
- A thin Zustand mirror only for picker UI state; the URL is authoritative.

### 3.4 Saved Views

Named scope+page combinations persisted server-side (`dashboards_saved_view`: id, tenantId, userId, name, route, scopeJson, shared?). Appear in the sidebar. Covers "my team's 12 repos", "payments portfolio", "release-week watchlist" — how users tame 200×60 day-to-day.

---

## 4. Information architecture (routes)

```
/login
/                     Overview (org rollup: health scores, top risks, trends)         [all roles]
/portfolio            Project Portfolio — 60 projects, virtualized table/grid          [PO/EM/CTO]
/repos                Repo Explorer — 200 repos, virtualized metric table              [Dev/Lead/EM]
/projects/:key        Project detail (epics, sprints, linked repos, metrics)
/repos/:owner/:name   Repo detail (PR metrics, review health, linkage coverage, orphans)
/sprints              Sprint dashboard (current sprints across selected projects)      [SM/Lead]
/compare              Compare mode (N entities side-by-side, any metric set)
/views/:id            Saved view (rehydrates route + scope)
/admin                Connections health, users, linkage coverage & orphan queue       [admin]
```

Persona dashboards from architecture §9 (Developer / EM / PO / CTO / CEO) are **compositions of the same widget framework over preset scopes**, added in Phase 3 — they don't require new plumbing.

### Page specs (summary)

- **Overview** — KPI strip (engineering-health, cycle-time p85, deployment freq, open risks) at current scope; trend sparklines; risk feed; "data coverage" banner (% repos linked, freshness).
- **Repo Explorer** — the workhorse for 200 repos. Virtualized TanStack table: one row per repo; columns = selectable metrics (server-batch fetched); sort/filter server-side; column presets ("Flow", "Review", "Quality"); row → repo detail. Bulk-select rows → send to Compare.
- **Project Portfolio** — same pattern for 60 projects: health score, epic progress, velocity trend, linked-repo count, risk count. Grid or table toggle.
- **Detail pages** — entity header (health + freshness), metric widget grid, linked entities via the graph (project ↔ repos, repo ↔ projects), drill-down: widget → contributing PRs/stories → lineage (raw events).
- **Compare** — 2–10 entities (same type) × chosen metrics; small-multiples charts + delta table.
- **Sprint dashboard** — per selected sprint(s): burndown, commitment vs completed, blocked/aging items, at-risk stories (per architecture §9.2).
- **Admin** — connection health (BC-0), ingestion lag, **linkage coverage + orphan queue** (correlation transparency), user management.

---

## 5. Widget framework

One contract so every metric renders consistently and new metrics need no bespoke UI:

```ts
interface MetricWidgetSpec {
  metricKey: string;              // from the metric catalog (METRICS.md)
  title: string; unit: 'hours'|'count'|'percent'|'score';
  viz: 'stat' | 'trend' | 'bar' | 'distribution' | 'table';
  supportsGroupBy: ScopeGroupBy[];
  rolesAllowed?: Role[];          // RBAC + metric-ethics gating
}
```

- **Registry**: `widgetRegistry[metricKey]` → when the backend ships `review_latency`, registering one spec makes it available in Explorer columns, detail pages, and Compare.
- **Shared shell**: every widget renders inside `<MetricCard>` which uniformly shows **value(s) + sample size + confidence badge + "computed X ago" + lineage link** (extends the existing PR-cycle-time card).
- **Primitives**: `StatCard`, `TrendChart`, `GroupedBarChart`, `DistributionChart` (p50/p85 emphasis per METRICS.md), `MetricTable`. Charting via **Recharts** (composable, small); tables via **TanStack Table + @tanstack/react-virtual**.
- **Empty/degraded states are first-class**: "no data in scope", "low confidence (n<5)", "collector lagging" — never silent zeros.

---

## 6. BFF API additions required (backend prerequisites)

The frontend plan is honest about its dependencies — these endpoints must exist (BC-13 read models):

| Endpoint | Purpose |
|---|---|
| `GET /api/catalog/projects?search=&page=` | Project picker + portfolio (60) |
| `GET /api/catalog/repos?search=&projects=&page=` | Repo picker + explorer (200; cross-filtered via correlation graph) |
| `GET /api/catalog/teams`, `/api/catalog/sprints?projects=` | Remaining pickers |
| `GET /api/dashboards/metrics?metrics=k1,k2&scope=<serialized>&groupBy=repo&page=` | **Batch** endpoint: N metrics × M entities in one call — never 200 requests |
| `GET /api/dashboards/summary?scope=` | Overview KPI strip + coverage/freshness |
| `GET /api/dashboards/lineage?metricValueId=` | Drill-down to contributing entities/events |
| `POST/GET/DELETE /api/views` | Saved views CRUD |

Rules: all tenant-scoped from JWT; server-side pagination/sort for anything unbounded; responses include `sampleSize`, `computedAt`, `coverage` per value (the widget shell depends on it).

---

## 7. Scale & performance engineering

- **Server aggregates, client renders.** No client-side math over raw entities; the batch metrics endpoint returns grouped, computed values.
- **One request per table view**, not per cell: batch endpoint with `metrics=[…]` + pagination (50 rows/page; virtualized rendering for smoothness).
- **React Query** keys = serialized scope; `staleTime` 30–60s; prefetch next page on scroll; `keepPreviousData` for filter changes.
- **Async pickers**: debounced (250ms) server search; selected items pinned; render ≤50 options at once.
- **Code-splitting** per route (`React.lazy`) — Explorer/Compare/Charts loaded on demand.
- **Budget**: initial JS < 250KB gz (today ~72KB); interactive < 2s on the dashboard route.

---

## 8. RBAC & metric ethics in the UI

- Route guards by role (matrix in §4); pickers only offer entities the role can see (server enforces regardless — UI filtering is UX, not security).
- **Individual-level data**: only in the Developer's own view ("my PRs/WIP"); Explorer/Compare group by repo/project/team — **never by developer**; no leaderboard-shaped UI anywhere (per AUTH-AND-RBAC §5).
- Admin-only surfaces: connections, users, orphan queue.

---

## 9. Phased delivery

**Phase F1 — Scope foundation** *(unblocks everything)*
Catalog endpoints (projects/repos/teams/sprints) + batch metrics endpoint (even with one metric) → Scope Bar with URL-state + async pickers → refactor Delivery dashboard onto the scope system (kill the free-text repo input).
*Exit:* pick any projects/repos/time combination via UI; PR cycle time renders per scope, grouped by repo.

**Phase F2 — Explorers** *(the 200×60 answer)*
Repo Explorer + Project Portfolio (virtualized tables, metric column presets, server sort/paginate) → detail pages with linked-entity navigation via the graph → widget registry + `<MetricCard>` shell extracted.
*Exit:* browse all 200 repos / 60 projects with sortable metric columns; click through to details; every number shows health/freshness.

**Phase F3 — Persona dashboards & sprints**
Overview (org rollup), Sprint dashboard (SM), EM/PO/CTO preset dashboards composed from the registry over preset scopes (architecture §9 content).
*Exit:* each persona lands on a role-appropriate default view.

**Phase F4 — Combination power tools**
Compare mode, Saved Views (server CRUD + sidebar), lineage drill-down UI, CSV/PNG export, orphan-queue admin view.
*Exit:* "any combination" is not just filterable but **nameable, shareable, and comparable**.

Each phase lands as its own PR with frontend-CI green; backend endpoint work for F1 is a parallel small PR (BC-13 read models over existing Prisma models).

---

## 10. Risks & open questions

| Risk | Mitigation |
|---|---|
| Batch metrics endpoint becomes slow at 200 repos × 5 metrics | Server-side: precomputed `metrics_value` rollups (already the BC-8 design) + pagination; measure before optimizing further |
| Project↔repo cross-filter depends on correlation coverage | Show "unlinked repos" bucket explicitly; admin orphan queue makes gaps visible instead of hiding them |
| Metric catalog outpaces widget registry | Registry entry is ~10 lines; add "register widget" to the metric definition-of-done in METRICS.md §10 |
| Scope serialization grows unwieldy in URLs (200 repos selected) | Selections >20 entities collapse to a server-side saved-selection id |

Open: chart library final call (Recharts default; revisit if p85 distribution plots need more), and whether Team entities land in BC-2 before F1 (pickers can ship project/repo-only first).

---

## 11. Change policy

New pages, widgets, scope dimensions, or BFF dashboard endpoints update this doc in the same change (Documentation-First). Widget registry entries are required for any new metric exposed to the UI (add to METRICS.md §10 checklist).
