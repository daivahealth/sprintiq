# Analytics (BC-10): the in-memory knowledge graph

Authoritative specification for the knowledge graph. It is a derived, in-memory relationship layer over repositories, developers and their engineering activity, and the first concrete build-out of BC-10 Analytics & Insight. It gets a new file because BC-10 had no feature doc to absorb it.

> Context:
> - [ADR-0013](../ADR/0013-in-memory-knowledge-graph.md) is the decision this ships under: the architecture and the admin-only ethics exception. Read it first.
> - [PRODUCT-ARCHITECTURE.md](../architecture/PRODUCT-ARCHITECTURE.md): BC-5 and BC-10.
> - [DATA-MODEL.md §3, §8](../architecture/DATA-MODEL.md): the tables it reads.
> - [api/README.md §6.2](../api/README.md): the post-write events.
> - [api/README.md §9](../api/README.md): the endpoints.
> - [security/AUTH-AND-RBAC.md §5.3](../security/AUTH-AND-RBAC.md): admin-only and audited.
> - [deployment/README.md §5.4](../deployment/README.md): configuration and sizing.

Code: `backend/src/analytics/knowledge-graph/`.

---

## 1. What it is, and what it is not

The graph answers two questions without bespoke SQL per question:
- **Repository identification.** Given a repository's name, URL or id: who worked in it, with how many commits, PRs and reviews, when they last did, and which Jira issues the work touched.
- **The reverse.** Given a developer: which repositories they worked in, their commits there, the PRs they created and reviewed, and their Jira issues.

It is a **projection**, not a store:
- Postgres remains the only source of truth.
- The graph holds keys and a few display attributes. Messages, LOC and file lists stay in Postgres.
- It writes nothing back.
- A restart rebuilds it.

Each tenant has its own graph object. No traversal can cross tenants, because there is no shared structure to cross.

## 2. What the schema holds (and does not)

The schema has **no foreign keys** (by design, ADR-0005), and there is no Repository, Developer or Team table. Every relationship below is a string join, and the graph projects only those that exist.

| Concept | Source table (Prisma model) | Graph node id | How it joins |
|---|---|---|---|
| Repository | `repoFullName` on `code_commit`, `code_pull_request`, `code_pr_review` | `REPOSITORY:<owner/name lower-cased>` | n/a. GitHub treats names case-insensitively, so the graph does too |
| Developer | `correlation_developer_identity` (`DeveloperIdentity`) | `DEVELOPER:<canonicalDeveloperId>` | `DeveloperIdentityService.attributionIndex()` / `jiraAssigneeIndex()`, reused rather than copied |
| Commit | `code_commit` (`Commit`) | `COMMIT:<id>` | Repo by `repoFullName`; author by `attributeCommit` (login first, else email) |
| Pull request | `code_pull_request` (`PullRequest`) | `PULL_REQUEST:<id>` | Repo by `repoFullName`; author by `authorLogin` → identity, falling back to the login itself |
| Review | `code_pr_review` (`PrReview`) | `REVIEW:<id>` | PR by (`repoFullName`, `externalNumber`); reviewer by `reviewerLogin` → identity |
| Jira issue | `planning_story` (`Story`) | `JIRA_ISSUE:<id>` | Assignee by the Jira assignee bridge (account id, else display name) |
| PR → issue | `correlation_link` (`edgeType = 'pr_implements_story'`) | edge | `fromId = "<repo>#<number>"`, `toId = Story.id`, with `confidence` and `method` |

**Not projected, because the data does not exist.** The model reserves the types so that adding them later is additive:
- **Teams.** There is no team or membership table, and nothing to attach repo ownership to. `TEAM`, `MEMBER_OF` and `OWNS` are always 0.
- **PR → all of its commits.** Only `headSha` is stored (DATA-MODEL.md §8, `pr_contains_commit` planned).
- **Commit → Jira issue.** `commit_implements_story` is still open (api/README.md §12 #7). Running the key regex over commit messages here would invent a link that correlation has not made.
- **The person who merged a PR.** `mergedBy` is a login that identity resolution never sees.

## 3. The graph model

The graph is a graphology `MultiDirectedGraph` per tenant. Edge keys are `TYPE|source|target`, and every write goes through `mergeNode`/`mergeEdgeWithKey`, which is what makes it idempotent.

```text
DEVELOPER ─CREATED──────▶ COMMIT ─BELONGS_TO─▶ REPOSITORY
DEVELOPER ─CREATED──────▶ PULL_REQUEST ─BELONGS_TO─▶ REPOSITORY
DEVELOPER ─CREATED──────▶ REVIEW ─BELONGS_TO─▶ PULL_REQUEST
DEVELOPER ─REVIEWED─────▶ PULL_REQUEST          (derived: count, lastAt)
DEVELOPER ─CONTRIBUTED_TO▶ REPOSITORY           (derived: lastAt)
PULL_REQUEST ─REFERENCES─▶ JIRA_ISSUE           (confidence, method)
JIRA_ISSUE ─ASSIGNED_TO──▶ DEVELOPER
DEVELOPER ─MEMBER_OF────▶ TEAM                  (reserved, empty)
TEAM ─OWNS──────────────▶ REPOSITORY            (reserved, empty)
FEATURE ─IMPLEMENTED_IN─▶ REPOSITORY            (reserved, §6)
FEATURE ─RELATES_TO─────▶ JIRA_ISSUE            (reserved, §6)
```

- **Derived edges are recomputed, never counted.**
  - `CONTRIBUTED_TO` exists while the developer has at least one commit, PR or review in the repository.
  - `REVIEWED` exists while they have at least one review on the PR.
  - Both are rebuilt from the nodes underneath whenever one of those nodes changes, so they cannot drift.
- **Repository, developer and issue nodes exist only while something connects to them.** Removing the last commit in a repository removes the repository.
- **Unattributed work stays.** A commit or review whose author resolves to nobody keeps its `BELONGS_TO` edge and simply has no `CREATED` edge. Reads count it as `unattributed`.
- **Developer flags.** Developer nodes carry `isBot`, `isAnonymized` and `excluded`, computed with the same helpers the boards use. Reads withhold them (§5) but keep their work in totals, the same split as `bridgeCoverage`.
- **Identity confidence is not on CREATED/ASSIGNED_TO edges.** `AttributionIndex` does not expose a per-alias score. Correlation confidence is on `REFERENCES` as stored.

## 4. Initialisation and synchronisation

### 4.1 Loading (`KnowledgeGraphManager`, `KnowledgeGraphLoader`, `GraphSourceReader`)

On `onApplicationBootstrap`, after the HTTP listener is up and without blocking it, the manager builds every tenant's graph in turn. One tenant's failure does not stop the rest. Each build is logged:

```text
[KnowledgeGraphLoader] tenant=<id> graph built since 2026-08-04T…: 41188 nodes, 83066 edges (DEVELOPER=103 REPOSITORY=161 COMMIT=15993 PULL_REQUEST=6321 REVIEW=6718 JIRA_ISSUE=11892) in 2951ms
```

What is loaded is bounded by `KNOWLEDGE_GRAPH_WINDOW_DAYS` (default 90), always using **source activity dates**:

| Rows | In the window when |
|---|---|
| Commits | `authoredAt ≥ windowStart` |
| Pull requests | still `open`, or `openedAt`/`mergedAt ≥ windowStart` |
| Reviews | `submittedAt ≥ windowStart`, on a loaded PR |
| PR → issue links | the PR is loaded and the story still exists |
| Jira issues | referenced by a loaded PR, **or** assigned to a resolvable developer and (not done, or `resolvedAt`/`sourceCreatedAt ≥ windowStart`). A null `statusCategory` counts as not done |

Our own `updatedAt` columns are never used. They move on every re-collection, and on the reference tenant using `Story.updatedAt` loaded 40k issues where the activity-date rule loads 12k. The window rule lives in `GraphSourceReader` and is applied identically to the full load and to single-row re-reads, so a rebuild and an incremental update cannot disagree.

Every `KNOWLEDGE_GRAPH_REBUILD_MINUTES` (default 30), each tenant is rebuilt **off to the side and swapped in whole**. Readers see the old graph until the new one is complete. A failed rebuild keeps serving the old graph, marked `stale`.

The graph is built only on HTTP-serving roles (`api`, `collector`), and only when `KNOWLEDGE_GRAPH_ENABLED` is not off. A worker never holds one.

### 4.2 Incremental updates (`KnowledgeGraphUpdater`)

Between rebuilds, the graph follows the post-write notifications (api/README.md §6.2): `code.commit.persisted`, `code.pull_request.persisted`, `planning.issue.persisted` and `correlation.link.persisted`. The guarantees:

- **No graph change without a committed write.** These events are published only after the owning context's write resolved, and they carry only a natural key. The updater re-reads the row from Postgres and applies what it finds:
  - a row that is gone, or has left the window, is removed;
  - a PR re-read replaces its whole review set and its issue links, which is how deletions and corrections land.
- **The publisher never waits.** Changes are queued per tenant and applied after the publishing call returns. Bursts for the same row coalesce into one re-read.
- **Idempotent.** Applying a row twice, or replaying a whole snapshot row by row, converges on the bulk-built graph. On the reference tenant's real data the two were compared node-for-node and edge-for-edge and matched.
- **Rebuild-safe.** Changes that arrive while a rebuild is reading Postgres are held and replayed onto the new graph after the swap, so the swap cannot lose them.
- **Failures don't corrupt.** A failed re-read marks the tenant `stale` (visible in `status` and every response's `freshness`), and the next rebuild corrects it.

What the events do not cover, and so only the periodic rebuild corrects:
- reconciler writes (api/README.md §9 *Data reconcilers*);
- identity re-resolution and admin identity overrides;
- window expiry.

**Multiple instances.** Each process builds and maintains its own graph, with no coordination. In production, ingestion runs in `collector`/`worker` pods, so `api` pods do not receive the in-process events. Their graph is at most one rebuild interval behind, and says so through `freshness`. The updater's input is just `{tenantId, change}`, so an outbox poller, Redis stream or Postgres CDC feed can replace the event subscriptions in `onModuleInit` without touching the rest.

### 4.3 Traversal (`graph-queries.ts`)

All reads are pure functions over one tenant's graph:
- **Repository → developers.** Walks the in-edges of the repository (commits and PRs), the PRs' in-edges (reviews), and each item's creator. Counts are computed at query time, so they cannot disagree with the edges.
- **Developer → repositories.** Walks the developer's out-edges (`CREATED`, `REVIEWED`, `CONTRIBUTED_TO`) and the referenced issues of their PRs, plus the in-edges `ASSIGNED_TO`.
- **Resolving the repository argument.** `resolveRepository` accepts `owner/name` in any case, a URL (`https://github.com/Owner/Name(.git)`), or a bare name. A bare name that matches several repositories is refused with the candidates (409) rather than guessed.

On the reference tenant's busiest repository (801 commits, 322 PRs, 439 reviews), the developers and activities reads together took 29 ms.

## 5. API and the rules it ships under

The endpoints, response shapes and audit actions are in api/README.md §9. The conditions come from ADR-0013 and are enforced in code:

1. **Admins only.** `@Roles(Role.ADMIN)` on every route.
2. **Audited.** Every read that returns names writes an audit row; `status` and `search` return none.
3. **Alphabetical.** People are ordered by display name and repositories by name. No count orders anything.
4. **The rule and freshness ship with every named-person response.**
5. **Suppressions before names.** Bots, anonymized accounts and admin-excluded identities are counted as `withheld` and never named; a direct lookup of one is a 404.
6. **Unattributed work is reported** (`unattributed`), never assigned to someone.

### 5.1 Sample responses

All names and ids below are illustrative.

`GET /api/knowledge-graph/status`

```json
{
  "status": "ready",
  "enabled": true,
  "windowDays": 90,
  "rebuildMinutes": 30,
  "tenant": {
    "state": "ready",
    "builtAt": "2026-11-02T11:40:02.114Z",
    "windowStart": "2026-08-04T11:39:59.000Z",
    "lastIncrementalAt": "2026-11-02T11:52:17.630Z",
    "stale": false,
    "error": null,
    "totalNodes": 41188,
    "totalEdges": 83066,
    "nodesByType": { "DEVELOPER": 103, "TEAM": 0, "REPOSITORY": 161, "COMMIT": 15993, "PULL_REQUEST": 6321, "REVIEW": 6718, "JIRA_ISSUE": 11892, "FEATURE": 0 },
    "edgesByType": { "MEMBER_OF": 0, "OWNS": 0, "CONTRIBUTED_TO": 1017, "CREATED": 29032, "BELONGS_TO": 29032, "REVIEWED": 6546, "REFERENCES": 5775, "ASSIGNED_TO": 11664, "IMPLEMENTED_IN": 0, "RELATES_TO": 0 }
  }
}
```

`GET /api/knowledge-graph/repositories/search?q=invoice`

```json
{
  "items": [
    { "id": "acme/invoice-service", "fullName": "acme/invoice-service", "url": "https://github.com/acme/invoice-service", "commitCount": 214, "pullRequestCount": 61 }
  ],
  "count": 1,
  "freshness": { "builtAt": "2026-11-02T11:40:02.114Z", "windowStart": "2026-08-04T11:39:59.000Z", "windowDays": 90, "lastIncrementalAt": null, "stale": false, "rebuildMinutes": 30 }
}
```

`GET /api/knowledge-graph/repositories/acme%2Finvoice-service/developers`

```json
{
  "repository": { "id": "acme/invoice-service", "fullName": "acme/invoice-service", "url": "https://github.com/acme/invoice-service" },
  "developers": [
    { "developerId": "asha-r_acme", "displayName": "Asha Rao", "commitCount": 88, "pullRequestCount": 24, "reviewCount": 31, "lastContributionAt": "2026-10-31T09:12:44.000Z" },
    { "developerId": "email:dev.kumar@acme.dev", "displayName": "Dev Kumar", "commitCount": 41, "pullRequestCount": 12, "reviewCount": 9, "lastContributionAt": "2026-10-29T14:03:10.000Z" }
  ],
  "totals": { "commits": 214, "pullRequests": 61, "reviews": 77 },
  "unattributed": { "commits": 3, "pullRequests": 0, "reviews": 0 },
  "withheld": { "commits": 82, "pullRequests": 25, "reviews": 37, "identities": 2 },
  "rule": "Admin-only (ADR-0013). Counts show where work happened in the loaded window, not how well anyone works: …",
  "freshness": { "builtAt": "2026-11-02T11:40:02.114Z", "…": "…" }
}
```

`GET /api/knowledge-graph/developers/asha-r_acme/repositories?limit=2`

```json
{
  "developer": { "developerId": "asha-r_acme", "displayName": "Asha Rao" },
  "repositories": [
    {
      "id": "acme/invoice-service", "fullName": "acme/invoice-service", "url": "https://github.com/acme/invoice-service",
      "commitCount": 88, "pullRequestsCreated": 24, "pullRequestsReviewed": 19, "reviewCount": 31,
      "lastContributionAt": "2026-10-31T09:12:44.000Z",
      "recentCommits": [
        { "sha": "9f1c2e7…", "authoredAt": "2026-10-31T09:12:44.000Z" },
        { "sha": "41ab08d…", "authoredAt": "2026-10-30T16:40:02.000Z" }
      ],
      "jiraIssues": [ { "key": "BILL-482", "title": "Invoice generation for credit notes", "status": "Done", "type": "story" } ]
    }
  ],
  "assignedIssues": [ { "key": "BILL-501", "title": "Invoice PDF footer", "status": "In Progress", "type": "task" } ],
  "rule": "…",
  "freshness": { "…": "…" }
}
```

`GET /api/knowledge-graph/repositories/invoice-service/activities?limit=1`

```json
{
  "repository": { "id": "acme/invoice-service", "fullName": "acme/invoice-service", "url": "https://github.com/acme/invoice-service" },
  "commits": { "total": 214, "items": [ { "sha": "9f1c2e7…", "authoredAt": "2026-10-31T09:12:44.000Z", "isMerge": false, "attribution": "person", "author": { "developerId": "asha-r_acme", "displayName": "Asha Rao" } } ] },
  "pullRequests": { "total": 61, "items": [ { "number": "312", "title": "BILL-482 credit-note invoices", "state": "merged", "openedAt": "2026-10-28T10:00:00.000Z", "mergedAt": "2026-10-30T12:15:00.000Z", "jiraKeys": ["BILL-482"], "attribution": "person", "author": { "developerId": "asha-r_acme", "displayName": "Asha Rao" } } ] },
  "reviews": { "total": 77, "items": [ { "prNumber": "312", "state": "approved", "submittedAt": "2026-10-30T11:02:00.000Z", "attribution": "withheld", "author": null } ] },
  "jiraIssues": { "total": 23, "items": [ { "key": "BILL-482", "title": "Invoice generation for credit notes", "status": "Done", "type": "story", "pullRequests": [ { "number": "312", "confidence": 0.8, "method": "regex" } ] } ] },
  "rule": "…",
  "freshness": { "…": "…" }
}
```

## 6. Feature discovery (designed for, not built)

The target journey: search "Invoice generation", reach a `FEATURE` node, then the repositories that implement it, their developers, those developers' commits and PRs, and the Jira issues behind them.

The model already supports it:
- `FEATURE` nodes keyed by a slug (`FEATURE:invoice-generation`), with `name` and `keywords`.
- `IMPLEMENTED_IN` edges to repositories and `RELATES_TO` edges to issues, each with the `confidence` and `method` that made it, as correlation links carry today.

Everything after the first hop is the traversal that already exists (§4.3). What is missing is only the matcher that creates FEATURE edges:
- **First**, deterministic keyword matching over repository names, PR titles and Jira issue titles and epics, scored and with evidence. It would land as correlation output in BC-5 (CLAUDE.md: "Correlation is the moat"), so the graph projects it rather than inventing it.
- **Later**, semantic matching over embeddings (BC-12, pgvector).
- No LLM, embedding or search is built in this POC.

Showing feature → developer results in any UI, or to any role but admin, falls under ADR-0013's "needs the decision taken again".

## 7. Known limits

- **Memory per instance per tenant.** About 100 MB of heap on the reference tenant at 90 days. The window is the lever.
- **`api` pods in production are up to one rebuild interval behind** (§4.2).
- **The full load scans each tenant's rows.** `code_pull_request` has no index on `openedAt`/`mergedAt`, and `correlation_link` none on `fromId` (DATA-MODEL.md §8). It runs once per rebuild and took 3 s on the reference tenant.
- **Cross-context reads.** `GraphSourceReader` reads BC-3, BC-4 and BC-5 tables directly, following the `DeveloperActivityService` precedent. It is the single seam to move behind owning-context read APIs on service extraction (ADR-0001).
