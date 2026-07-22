# SprintIQ API & Integration Contract

Authoritative reference for SprintIQ's API surface, with emphasis on the **native collector model**: inbound **webhook receivers** + **scheduled pollers**, the internal **ingestion pipeline**, and **native outbound notifications**.

> See [PRODUCT-ARCHITECTURE.md](../architecture/PRODUCT-ARCHITECTURE.md) for context (BC-1 Collectors & Ingestion, BC-15 Notifications, §11 Integration, §12 Event Flow) and [ADR-0003](../ADR/0003-native-collectors-replace-n8n.md) for why integration is native (not n8n). This document specifies *how* external systems are collected and how SprintIQ delivers outbound. It does not restate architecture.

---

## 0. Boundary rules (non-negotiable)

- **Collectors (BC-1) are the only door to the outside world.** All communication with source systems — inbound webhooks *and* outbound polling/API calls — lives in the Collector context. No other context calls a source API or receives its webhooks.
- **One internal ingestion pipeline** for every collected event (push or pull): **verify signature → idempotency → raw-event store → normalize → domain event.**
- **All data is tenant-scoped.** Every collected event resolves to exactly one `tenant_id` + `connection_id` via the connection registry (BC-0).
- **Source credentials are secrets** (OAuth/app-install/PAT tokens, webhook secrets) stored by reference in vault/KMS — never plaintext, never logged.

---

## 1. Collector anatomy

Each source system has one **native collector** (a NestJS module under `collectors/`) composed of three parts plus shared pipeline:

| Part | Responsibility |
|---|---|
| **Typed API client** | Authenticated calls to the source (OAuth app / GitHub App installation / PAT); token refresh; pagination; rate-limit backoff. |
| **Webhook receiver** | Public HTTPS endpoint `POST /webhooks/{source}`; per-provider signature verification; hands payload to the pipeline. |
| **Scheduled poller** | NestJS Scheduler job; incremental sync via cursors; backfill; reconciliation for missed webhooks and sources with weak/no webhooks. |
| **Normalizer** | Maps source payload → canonical envelope/domain events (shared contract, §4). |

A **shared collector framework** provides the common primitives (client base, retry/backoff, cursor store, webhook-verification middleware, envelope builder) so each new source is thin and consistent.

Sources (current + planned): `jira`, `github`, `gitlab`, `azure-devops`, `sonarqube`, `jenkins`, `github-actions`.

---

## 2. Inbound: webhook receivers

### 2.1 Endpoints
- `POST /webhooks/jira`
- `POST /webhooks/github`
- `POST /webhooks/gitlab`
- `POST /webhooks/azure-devops`
- `POST /webhooks/sonarqube`
- `POST /webhooks/jenkins`
- `POST /webhooks/github-actions`

Each endpoint resolves the tenant/connection from the delivery (path token, installation id, or a per-connection routing key embedded at subscription time), verifies the provider signature, and feeds the pipeline. Endpoints return fast (after durable raw persistence) so providers don't time out.

### 2.2 Per-provider signature verification (mandatory)

Each provider has its own scheme; verify per-provider and treat unverified payloads as hostile.

| Source | Verification | Header / mechanism |
|---|---|---|
| GitHub / GitHub Actions | HMAC-SHA256 of body with the webhook secret | `X-Hub-Signature-256` |
| GitLab | Shared secret token compare (constant-time) | `X-Gitlab-Token` |
| Jira | Shared secret / JWT (Connect app) or signed secret | `Authorization` / query JWT |
| Azure DevOps | Basic-auth secret or shared key per subscription | `Authorization` |
| SonarQube | HMAC of body with webhook secret | `X-Sonar-Webhook-HMAC-SHA256` |
| Jenkins | Shared token (plugin-dependent) + IP allow-list | header/token |

Common guards across all: **replay/timestamp window** where the provider supports it, **rate-limit/abuse controls**, and rejection of any payload whose connection can't be resolved.

### 2.3 Responses

| Code | Meaning |
|---|---|
| `202 Accepted` | Verified + raw-persisted + queued. |
| `200 OK` | Duplicate (idempotent replay). |
| `400` | Malformed payload. |
| `401` | Signature/secret verification failed. |
| `404 / 409` | Connection not resolvable / tenant mismatch. |
| `429` | Rate-limited (includes `Retry-After`). |
| `503` | Backpressure; provider should retry. |

---

## 3. Inbound: scheduled pollers & backfill

Webhooks are lossy and some sources have weak webhook support. A single scheduled sweep (`CollectorSchedulerService`, NestJS `@Cron(EVERY_5_MINUTES)`) iterates every active connection and calls that source's `poll()`, which owns pagination, rate-limit backoff, and cursor persistence.

- **One mechanism covers both backfill and incremental sync.** A connection starts in **backfill mode** (`collection_mode: "backfill"`): it walks history back to a floor date, either `connection.config.backfillSince` (ISO date, optional) or a default **90-day lookback**. Once the walk reaches that floor (or runs out of pages), the connection flips to **incremental mode** (`collection_mode: "poll"`) permanently, using a persisted watermark cursor to fetch only what changed since the last tick.
- **Per-tick page budget.** Each tick fetches at most **3 pages per entity** (GitHub: 100/page; Jira: 50/page) so one scheduler run never blocks on a large history — a big repo/project catches up gradually over several ticks via a resumable cursor (`Connection.syncCursors`, BC-0), not in one shot.
- **Rate-limit backoff.** GitHub: reads `X-RateLimit-Remaining`/`X-RateLimit-Reset`, stopping the tick pre-emptively at `remaining <= 1` (without discarding the page just fetched) and on a hard `403`/`429`. Jira: reads `Retry-After` on `429`. Either way the reset time is persisted to `Connection.rateLimitState`; the next tick skips that connection entirely (no API calls) until the cooldown passes.
- **Convergence:** polled/backfilled events use the **same canonical envelope and idempotency keys** as webhooks (e.g. a backfilled commit and a later `push` webhook for the same sha both key on `github:{repo}:commit:{sha}`), so push and pull de-dupe to one persisted result.
- **What isn't pulled:** GitHub commit backfill uses the list endpoint only — no per-commit detail call — so backfilled commits have `additions`/`deletions` unset, same as `push`-webhook commits. Doing per-commit enrichment during a historical backfill would be an N+1 call per commit, defeating the point of rate-limit safety for exactly the large histories backfill targets.
- **Connection config keys consumed by the sync:** GitHub — `repoFullName` (required), `backfillSince` (optional ISO date); Jira — `siteUrl`, `email` (required), `projectKey` (optional JQL filter), `backfillSince` (optional ISO date).
- **Backfill window is admin-configurable.** `admin/configuration` exposes a `backfillDays` field (github/jira, optional — defaults to 90) that resolves to `backfillSince = now - backfillDays` at save time (§9). Changing `backfillDays` (or, for github, `repoFullName` — the connection's collection *target*) on an existing connection clears `Connection.syncCursors`, so the sync re-walks from the new floor instead of a since-completed backfill silently ignoring a widened/narrowed window forever. Saving with the window *unchanged* does **not** recompute `backfillSince` or touch cursors — it's resolved once per distinct value, not re-derived from "now" on every save (which would otherwise drift the floor forward on each unrelated edit).
- Cadence (5 min) and page budgets are presently fixed constants in each collector, not yet environment-tunable.

---

## 4. The canonical envelope

Both webhook receivers and pollers normalize into one **canonical envelope** that wraps a source-specific payload. The envelope is stable; only `data` varies by `event_type`.

```jsonc
{
  "schema_version": "1.0",
  "event_id": "evt_01H...",            // unique per collected delivery (ULID)
  "idempotency_key": "github:acme/payments:pr:4521:merged",  // deterministic per logical event
  "source_system": "github",
  "connection_id": "conn_8f...",        // which registered connection (BC-0)
  "collection_mode": "webhook",         // webhook | poll | backfill
  "event_type": "code.pull_request.merged",
  "occurred_at": "2026-06-30T10:00:00.000Z",  // when it happened in the source
  "collected_at": "2026-06-30T10:00:01.200Z", // when the collector ingested it
  "external_refs": {                    // raw source identifiers (VARCHAR, never UUID)
    "repo": "acme/payments", "pr_number": "4521", "org": "acme"
  },
  "actor": { "source_login": "jdoe", "email": "jdoe@acme.com", "display_name": "Jane Doe" },
  "data": { /* event-type-specific, see §6 */ }
}
```

**Rules**
- `idempotency_key` MUST be deterministic for the same logical source event so webhook and poll converge.
- `external_refs` IDs are **strings** (external IDs are VARCHAR, never re-minted as UUID).
- `tenant_id`/`connection_id` are resolved by the collector from the connection registry, never trusted from arbitrary payload fields.
- Unknown `data` fields are preserved in the raw store (forward-compatible) and ignored by normalization until modeled.

---

## 5. Idempotency & delivery semantics

- **At-least-once collection (webhooks + pollers) → effectively-once persistence.** The pipeline keys on `(tenant_id, idempotency_key)`.
- First time → raw event stored, normalization enqueued.
- Duplicate → no re-processing (deduped on the unique index).
- The **raw event store is append-only and replayable** — re-running normalization/correlation after logic changes never requires re-fetching from sources.

---

## 6. Example: PR merged (GitHub)

Arrives at `POST /webhooks/github` (or via the GitHub poller during reconciliation). After `X-Hub-Signature-256` verification it is normalized to:

```jsonc
{
  "schema_version": "1.0",
  "event_id": "evt_01J9...",
  "idempotency_key": "github:acme/payments:pr:4521:merged",
  "source_system": "github",
  "connection_id": "conn_8f2a",
  "collection_mode": "webhook",
  "event_type": "code.pull_request.merged",
  "occurred_at": "2026-06-30T10:00:00.000Z",
  "collected_at": "2026-06-30T10:00:01.200Z",
  "external_refs": { "org": "acme", "repo": "acme/payments", "pr_number": "4521" },
  "actor": { "source_login": "jdoe", "email": "jdoe@acme.com", "display_name": "Jane Doe" },
  "data": {
    "title": "PAY-2231 fix idempotent capture on retry",
    "branch": "feature/PAY-2231-idempotent-capture",
    "base_branch": "main",
    "state": "merged",
    "merged_by": "asmith",
    "additions": 142, "deletions": 38, "changed_files": 6,
    "commits": [
      { "sha": "9af3...", "message": "PAY-2231 guard duplicate capture", "author_email": "jdoe@acme.com" }
    ],
    "reviews": [
      { "reviewer": "asmith", "state": "approved", "submitted_at": "2026-06-30T09:40:00Z", "comment_count": 3 }
    ],
    "opened_at": "2026-06-29T14:00:00Z",
    "merged_at": "2026-06-30T10:00:00Z"
  }
}
```

Correlation (BC-5) extracts `PAY-2231` from `title`/`branch`/commit messages and links PR 4521 → Story PAY-2231 → its Epic, with a confidence score. Unmatched PRs become **orphans** surfaced in the admin/linkage view — never silently dropped or guessed.

### Internal event-type families
Normalized `event_type`s are grouped by domain context (source-agnostic): `planning.*` (BC-3), `code.*` (BC-4), `ci.*` (BC-6), `quality.* / security.*` (BC-7). The same family is produced regardless of which source (GitHub vs GitLab vs ADO) emitted it.

---

## 7. Connection lifecycle (onboarding)

Tenants connect a source through the Admin app (BC-2/BC-0), not by operating any external tool. For GitHub/Jira today that's the `admin/configuration` screen (§9) rather than a dedicated connections UI — `POST /api/admin/connections` still exists for direct/manual registration (other sources, multiple repos, etc.), but there is no dedicated frontend page for it yet.

1. **Authorize:** OAuth app flow / install the GitHub App / paste a Jira/ADO token. Credentials stored by secret reference.
2. **Register connection:** creates a `connection` (BC-0) with `tenant_id`, `source_system`, scopes, and a webhook secret — for github/jira, saving `admin/configuration` as active does this automatically once the identifying fields are complete (§9).
3. **Subscribe webhooks:** the collector registers webhooks with the source (or instructs the admin) pointing at `/webhooks/{source}`.
4. **Initial backfill:** the scheduled sync sweep imports history; cursors initialized (§3).
5. **Steady state:** webhooks (real-time) + the scheduled sweep (reconciliation) run continuously; health/lag surfaced back on the same config screen via `connection.status`/`lastSyncAt`.

---

## 8. Outbound notifications (native delivery)

SprintIQ delivers notifications **natively** — no external automation hop. BC-15 resolves audience/throttling/quiet-hours, then the Collector context's outbound clients deliver:

| Channel | Mechanism |
|---|---|
| Slack | Slack API / incoming webhook per connected workspace |
| Microsoft Teams | Teams incoming webhook / Graph per connection |
| Email | SMTP / transactional email provider |

- SprintIQ decides **whether** to notify (preferences, throttle, quiet hours, severity); the delivery client decides only **how** to format for the channel.
- Delivery is retried with backoff and **audit-logged** with the provider's delivery result (BC-16).
- Human-approved agent actions (e.g., post a sprint summary, open a Jira ticket) use the same governed outbound clients.

---

## 9. Dashboard / application API (BFF) — summary

The frontend talks to a read-optimized BFF (BC-13), separate from collectors.

- **Auth:** `POST /api/auth/login` takes **email + password only** (no tenant id — email is globally unique; the tenant is resolved from the user and embedded in the returned JWT, ADR-0006). `GET /api/auth/me` returns the current user + active tenant. All other endpoints are JWT-scoped; tenant is derived from the signed token, never a client header.
- **Admin/RBAC:** `GET /api/admin/roles`, `GET /api/admin/users`, `POST /api/admin/users`, and `PATCH /api/admin/users/{id}/roles` require the `admin` role. User reads and role writes are tenant-scoped from the JWT; role updates validate against the canonical role catalog and cannot remove the tenant's last admin.
- **Tenant configuration:** `GET /api/admin/configurations/catalog`, `GET /api/admin/configurations`, and `PUT /api/admin/configurations` require the `admin` role. Configuration is tenant-scoped and keyed by namespace (`github`, `jira`, `llm`, `notifications`, `metrics`, `security`) + key (`default` today). Non-secret settings live in `values`; credentials/webhook/API keys are stored only as `secretRefs`, which must match the environment-variable-name convention (`^[A-Z][A-Z0-9_]*$`, e.g. `GITHUB_TOKEN`) — a raw token or URL is rejected server-side, not just discouraged by UI copy. The catalog endpoint marks fields `required`; the server rejects `PUT` with `status: "active"` if a required field is missing (an incomplete namespace can still be saved as `status: "disabled"`). `PUT` accepts an optional `expectedUpdatedAt` for optimistic concurrency — a mismatch against the stored row's `updatedAt` returns `409 Conflict` rather than silently overwriting a concurrent edit. Every successful `PUT` is audit-logged (`configuration.created`/`configuration.updated`) with the namespace, status, and which value/secretRef *keys* changed — never the values themselves.
  - **`github`/`jira` are bridged to a real BC-0 Connection.** Saving one of these namespaces creates/updates a Connection the collector scheduler actually runs against — `admin/configuration` is no longer config-only for these two. GitHub needs `organization` **and** `defaultRepo` (derived into `repoFullName`); Jira needs `siteUrl` **and** `email` (Basic-auth identity — `email` isn't catalog-required, but the bridge needs it to reach Jira). Until those are filled in, the row can still be saved (per the required-field rules above) but no Connection is created, so nothing collects. Toggling `status` to `disabled` flips the underlying Connection to `disabled` too (excluded from the scheduler sweep, §3), and re-saving updates the *same* Connection rather than creating a duplicate (matched by a deterministic `name`, not by source system alone — a tenant may have other independently-registered connections for the same source). Every config response includes a `connection: { linked, status, lastSyncAt, syncLagSeconds } | null` summary (`null` for the config-only namespaces) so the admin UI never implies "saved as active" means "collecting" when it isn't.
  - **`backfillDays` (optional number, both namespaces):** how many days of history to import on first sync — defaults to 90 if left blank. Resolved to an absolute `backfillSince` floor once, at the point it's set/changed (§3); editing other fields on the same save doesn't recompute or drift it.
  - **Secret values can be pasted directly, for any `secret-ref` field in any namespace** (not just github/jira) — `PUT` accepts an optional `secretValues: { [fieldKey]: string }` alongside `secretRefs` (the ref *name*, unchanged) and an optional `clearSecrets: string[]` (field keys whose stored value to delete). A value is rejected with `400` if no ref name is set for that field yet. Values are encrypted (`SecretsService`, AUTH-AND-RBAC.md §7) and **never** appear in any response or audit entry — omitting a field from `secretValues` leaves its stored value (if any) untouched, so a save that only edits an unrelated field never wipes a previously-pasted secret. Every config response includes `secretsConfigured: { [fieldKey]: boolean }` (is a value stored in the DB for this field) and the catalog response includes `secretsStoreEnabled: boolean` (is `SECRETS_ENCRYPTION_KEY` configured server-side at all) so the UI can explain itself instead of failing opaquely.
- Read-heavy: metrics series, dashboard widgets, risk feed, delivery-graph queries, agent chat.
- Current dashboard metrics endpoint: `GET /api/dashboards/metrics?metrics=pr_cycle_time,loc_added_deleted,bug_count&groupBy=repo|project|developer|day&repos=&projects=&from=&to=` returns tenant-scoped rows with metric cells, sample sizes, and `computedAt`. Developer grouping is activity context, not a productivity ranking.
- Current catalog endpoints: `GET /api/catalog/projects?search=` and `GET /api/catalog/repos?search=&projects=&page=`; repo catalogs can be cross-filtered through the delivery graph.
- Writes are limited to user/governance actions: recommendation decisions, saved views, config, connection management, approving agent actions.
- Detailed BFF endpoints are specified per-module under `docs/features/` as they are built.

---

## 10. Auditing & lineage

- Every collected event and every outbound delivery is audit-logged (BC-16): connection, `event_id`, `event_type`, `collection_mode`, result, latency — **never** the secret or full PII payload.
- The raw event behind any normalized fact, metric, or risk is retrievable for lineage ("every dashboard number traces to source events").

---

## 11. Contract change policy

Any change to the canonical envelope, an `event_type`, a webhook-receiver/signature scheme, a poller cursor contract, or the outbound delivery behavior **must** update this document in the same session (Documentation-First per `CLAUDE.md`/`AGENTS.md`), and warrants an ADR if it alters the collector boundary.
