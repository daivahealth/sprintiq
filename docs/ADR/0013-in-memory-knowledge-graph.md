# ADR-0013: In-memory knowledge graph, with admin-only attributed reads

- **Status:** Accepted — implemented 2026-11-02 (proof of concept)
- **Date:** 2026-11-02
- **Deciders:** Product owner
- **Related:** [CLAUDE.md](../../CLAUDE.md) ("Metrics are ethics-first"), [ADR-0001](0001-modular-monolith-first.md), [ADR-0004](0004-data-access-and-tenancy.md) (graph store deferred), [ADR-0005](0005-prisma-single-schema.md), [ADR-0009](0009-attributed-commit-digest.md), [ADR-0011](0011-per-developer-loc-chart.md), [ADR-0012](0012-per-developer-copilot-usage.md), [features/ANALYTICS.md](../features/ANALYTICS.md), [api/README.md §6.2, §9](../api/README.md), [security/AUTH-AND-RBAC.md §5.3](../security/AUTH-AND-RBAC.md), [deployment/README.md](../deployment/README.md)

## Context

The question to answer is "who works on this repository, and on what?", plus its reverse, "where does this developer work?". Later, it extends to "which repositories implement this feature?". Answering it means walking relationships that the schema keeps as string joins rather than foreign keys:

- repository → commits and PRs (`repoFullName`)
- PR → reviews (`repoFullName` + `externalNumber`)
- author → developer (identity resolution, BC-5)
- PR → Jira issue (`correlation_link`)
- Jira issue → assignee (the assignee bridge)

There are no Repository, Developer or Team tables (DATA-MODEL.md §3).

[ADR-0004](0004-data-access-and-tenancy.md) deferred a graph database: "revisit if graph queries become the bottleneck (would warrant its own ADR)". Nothing here is a bottleneck that justifies new infrastructure, and Postgres must stay the source of truth.

A view that lists named developers beside their commit, PR and review counts per repository is individual-level output. Under CLAUDE.md's ethics-first rule that is default-deny. None of the three earlier exceptions covers it: the Sprint Health board, the digest and its Watchlist view (ADR-0009), the Developer page LOC chart (ADR-0011), and the Copilot column (ADR-0012).

## Decision

### 1. A derived, per-process, in-memory graph

BC-10 Analytics holds one [graphology](https://www.npmjs.com/package/graphology) `MultiDirectedGraph` **per tenant** in process memory. It is built from Postgres and treated purely as a derived projection:

- **No new tables, and no writes to Postgres.** A restart rebuilds the graph from scratch.
- **Bounded by a window.** The window (`KNOWLEDGE_GRAPH_WINDOW_DAYS`, default 90) uses source activity dates (`authoredAt`, `openedAt`/`mergedAt`, Jira `resolvedAt`/`sourceCreatedAt`). It never uses our own `updatedAt`, which moves on every re-collection.
- **Built off to the side and swapped in whole.** This happens on startup and every `KNOWLEDGE_GRAPH_REBUILD_MINUTES`. Startup does not block HTTP; reads answer 503 until the tenant's graph exists.
- **Kept current between rebuilds** by a new family of post-write events, `*.persisted` (api/README.md §6.2):
  - The owning contexts (Code, Planning, Correlation) publish them only after their write resolved, and the payload is the row's natural key only.
  - The graph re-reads the row and applies it idempotently, so a failed write can never reach the graph.
  - The subscription is the only part tied to the in-process bus; an outbox or CDC feed can replace it later.
- **Built on HTTP-serving roles only** (`api`, `collector`). Every instance builds its own graph, and nothing is coordinated between them.
- **Reads of other contexts' tables sit behind one class** (`GraphSourceReader`), following the existing `DeveloperActivityService` precedent. On extraction they move behind owning-context read APIs (ADR-0001).

### 2. Admin-only attributed reads: a fourth, independent ethics exception

This is a new, independent exception to the ethics-first rule. It inherits none of the earlier decisions and covers only the `/api/knowledge-graph/*` routes. The conditions below are load-bearing and enforced in code:

1. **Admins only.** Every route is `@Roles(Role.ADMIN)`, enforced server-side.
2. **Audited.** Every read that returns names writes an audit row:
   - `analytics.knowledge_graph.repository_developers.view`
   - `analytics.knowledge_graph.developer_repositories.view`
   - `analytics.knowledge_graph.repository_activities.view`

   `status` and repository `search` return no names and are not audited, the same split as AUTH-AND-RBAC.md §5.2.
3. **Never an ordering of people.** Developers are always listed alphabetically by display name, and repositories by name. No route sorts or filters people by a count.
4. **The rule ships with the data.** Every named-person response carries `rule`, which states:
   - the counts are where work happened, not how well anyone works;
   - the ordering is alphabetical;
   - bots and exclusions are withheld;
   - unattributed work is reported rather than reassigned.

   It also carries `freshness`: when the graph was built, the window, and the last incremental update.
5. **Suppressions before names.** Bots (`isBotDeveloper`), anonymized accounts (`isAnonymizedAccount`) and admin-excluded identities (`DeveloperIdentity.excluded`) are never named. Their work stays in repository totals as `withheld`, and a direct developer lookup of one answers 404. Work whose author resolves to nobody is counted as `unattributed` and never assigned to anyone.
6. **Nothing invented.** Only relationships Postgres records are projected:
   - No team membership or ownership (no source data).
   - No PR → commit membership beyond what is stored.
   - No commit → Jira links (`commit_implements_story` is still open, §12 #7).

   `TEAM` and `FEATURE` node types are reserved and empty.

**This decision does not extend anywhere else.** The graph's counts do not feed the Sprint Health grade, the digest, the Watchlist, the Developer page, any notification, or any AI agent. Any UI for these routes, any role other than admin, and any figure derived from them (ownership share, bus factor, "top contributor") each need the decision taken again.

## Consequences

- **Memory is the cost.** On the reference tenant, a 90-day window held about 41k nodes and 83k edges: 16k commits, 6.3k PRs, 6.7k reviews, 11.9k Jira issues and 161 repos. That took about 100 MB of heap and a 3 s build. Each instance pays this per tenant. The window is the lever.
- **Freshness differs by process in production.** Ingestion runs in the `collector` and `worker` processes, and the in-process `*.persisted` events never reach an `api` pod. There, the graph is at most `KNOWLEDGE_GRAPH_REBUILD_MINUTES` behind; `status` and every response's `freshness` say when it was built. The `collector` role serves HTTP and sees its own events. An outbox or CDC feed (§1) is what closes the gap.
- **Some writes bypass the event bus.** The reconcilers and identity re-resolution write without publishing. The periodic rebuild is the correction path for them, as it is for window expiry.
- **Identity confidence is not projected onto CREATED/ASSIGNED_TO edges.** `AttributionIndex` does not expose a per-alias score, and inventing one would misstate it. Correlation confidence (`REFERENCES`) is projected as stored.

## Alternatives considered

- **A graph database (Neo4j and similar).** Rejected for the same reason ADR-0004 deferred it: it adds infrastructure, a second store to keep consistent, and a second tenancy boundary, for queries Postgres-fed memory answers in tens of milliseconds.
- **Recursive SQL per request.** Viable for the repository → developers rollup, but each traversal would be a bespoke query over unindexed string joins (`correlation_link.fromId` has no index). A shared in-memory projection gives one model for all of them and for the feature-discovery extension.
- **Subscribe to the existing ingestion events (`code.pull_request.*`).** Rejected. The in-process bus runs those handlers concurrently with the write, so the graph could see a row before, or without, its commit.
- **Team-level aggregates only, with no names.** This is the ethics rule's default. It was offered and declined: the request is explicitly "which developers, on which repository". The admin-only, audited, alphabetical shape is the narrowest version that answers it.
