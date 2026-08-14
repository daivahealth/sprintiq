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

Webhooks are lossy and some sources have weak webhook support. GitHub and Jira each have their own **independent** scheduled tick (`CollectorSchedulerService.tickGithub()` / `tickJira()`, both NestJS `@Cron(EVERY_5_MINUTES)`) — one source's cadence never blocks or couples to the other's. Each tick is a cheap **due-check**, not the sync cadence itself: it lists that source's active connections and calls `poll()` (owning pagination, rate-limit backoff, and cursor persistence) only for connections whose own configured interval has actually elapsed since their last sync.

- **Connections are swept neediest-first, and sweeps never overlap.** `findActiveBySource` orders by `lastSyncAt ASC NULLS FIRST` (never-synced first, then most stale), and a tick whose predecessor is still running skips rather than starting a second pass. Both only matter at org scale and both are load-bearing there: an org sync registers **one connection per repo** (195 on a real tenant), a full sweep of that many takes far longer than the 5-minute cadence, and a connection still backfilling is **always due regardless of its interval** (see below) — so with no ordering every sweep restarts at the same head of the list, re-polls repos that synced minutes ago, and never reaches the tail. The backlog starves instead of converging, and no interval setting fixes it because backfilling connections ignore the interval. An unfinished sweep stops blocking after 45 minutes so a process killed mid-sweep can't strand the source, and the tick closes its `SchedulerTick` row in a `finally` so an error can't leave it open.
- **One mechanism covers both backfill and incremental sync.** A connection starts in **backfill mode** (`collection_mode: "backfill"`): it walks history back to a floor date, either `connection.config.backfillSince` (ISO date, optional) or a default **90-day lookback**. Once the walk reaches that floor (or runs out of pages), the connection flips to **incremental mode** (`collection_mode: "poll"`) permanently, using a persisted watermark cursor to fetch only what changed since the last tick.
- **The backfill floor is pinned once per pass, never re-derived mid-backfill.** When `backfillSince` isn't explicitly configured, **both** collectors compute the 90-day default on the *first* poll of a backfill pass and immediately persist it onto `connection.config.backfillSince` (self-healing, same pattern as caching resolved custom-field ids) — neither recomputes "now − 90 days" fresh on every tick. A drifting floor breaks the two collectors differently, and both are real: Jira Cloud's `/search/jql` `nextPageToken` is bound to the exact JQL text that produced it, so a shifted floor invalidates any in-flight resume token; GitHub's page-number pagination survives that, but its floor comparison creeps forward while a multi-tick backfill is still walking, silently truncating the oldest slice of the window it was meant to collect.
- **A rejected pass is recorded on the connection, not just logged.** Zero collected events is ambiguous — it means "nothing changed" for a healthy connection and "couldn't run" for one whose token was revoked, and a rejected pass still stamps `lastSyncAt`, so the timestamp can't tell them apart either. Collectors write `Connection.lastError` / `lastErrorAt` when a pass fails (including "no credential resolved for this secret ref") and clear them on the next clean pass, so a connection recovers by itself. Sync Status shows a `failing` badge and the reason; `admin/configuration` replaces "Collecting" with the failure rather than reporting green.
- **A failed request is never mistaken for "no more results".** Both clients flag a non-2xx, non-rate-limit response (`failed`) rather than returning an empty page indistinguishable from exhaustion. The collectors treat that as "stop this tick, keep the cursors, retry" — never as backfill completion. Without this, a revoked token, a renamed/deleted repo, an SSO-blocked org, or an expired page token would permanently mark a connection fully backfilled having collected nothing.
- **Enrichment resumes mid-page, not at the top of it.** When the per-tick enrich budget runs out partway through a page, GitHub's collector persists both the page number *and* the index reached (`prPageOffset` / `commitsPageOffset`). Storing only the page number would make every tick re-enrich the same first N items of a larger page and never advance it — the backfill would never finish while burning the entire detail-call budget each tick.
- **Per-tick page budget.** Each tick fetches a bounded number of pages so one scheduler run never blocks on a large history — a big repo/project catches up gradually over several ticks via a resumable cursor (`Connection.syncCursors`, BC-0), not in one shot. The budgets differ per source because the cost profile does: **Jira 20 pages × 100/page** (its `/search/jql` hard-caps `maxResults` at 100, and a page returns whole issues — no per-issue call, so a tick is ~20 requests), versus **GitHub 3 pages × 100/page**, where the real bound is the per-tick *enrichment* budget (`COMMIT_ENRICH_BUDGET_PER_TICK` / `PR_ENRICH_BUDGET_PER_TICK`, 25 each) because line-change stats need a detail call per commit and per PR.
- **Rate-limit backoff.** GitHub: reads `X-RateLimit-Remaining`/`X-RateLimit-Reset`, stopping the tick pre-emptively at `remaining <= 1` (without discarding the page just fetched) and on a hard `403`/`429`. Jira: reads `Retry-After` on `429`. Either way the reset time is persisted to `Connection.rateLimitState`; the next tick skips that connection entirely (no API calls) until the cooldown passes.
- **Convergence:** polled/backfilled events use the **same canonical envelope and idempotency keys** as webhooks (e.g. a backfilled commit and a later `push` webhook for the same sha both key on `github:{repo}:commit:{sha}`), so push and pull de-dupe to one persisted result.
- **Commit line-change stats.** GitHub's commit list endpoint never includes `additions`/`deletions`/`changed_files` — only a per-commit detail call (`GET /repos/{repo}/commits/{sha}`) does. The GitHub poller makes that call per commit under a bounded per-tick budget (`COMMIT_ENRICH_BUDGET_PER_TICK`, currently 25); commits beyond the budget are deferred to a later tick rather than ingested with stats missing — a commit's idempotency key makes its stats permanent once first ingested, so "ingest now without stats" would be a silent, permanent gap, not a temporary one. `push`-webhook commits still have `additions`/`deletions` unset (the payload doesn't carry them at all, and per-event volume there is low enough that it's a smaller gap than backfill's was).
- **Review comment counts and bot classification.** `GET /repos/{repo}/pulls/{number}/comments` is the only source of per-review inline comment counts (each comment carries its `pull_request_review_id`), which `review_depth` and `rubber_stamp_rate` need. It is a **4th** per-PR call, made only when the PR actually has reviews to attribute comments to. `pr_review.comments_counted` records whether the count ran: without it, "reviewed with zero comments" — the rubber-stamp finding — is indistinguishable from "never counted", and every PR collected before comment counting existed would be indicted retroactively. Reviews are classified as automation at collection time from GitHub's own `user.type == "Bot"`, with the `name[bot]` login as fallback; **every people metric counts humans only** (METRICS.md §0).
- **Per-tick budgets are environment-tunable.** `GITHUB_PAGE_BUDGET_PER_TICK`, `GITHUB_COMMIT_ENRICH_BUDGET_PER_TICK` and `GITHUB_PR_ENRICH_BUDGET_PER_TICK` override the defaults (3 / 25 / 25). One PR-enrich unit is **4 API calls**, so the default 25 costs ~100 requests per connection per tick — and an org sync registers one connection per repo. Size these per deployment (§12 #14).
- **PR reviews.** Only `GET /repos/{repo}/pulls/{number}/reviews` carries them — not the list endpoint, not the PR detail, not the `pull_request` webhook payload. Each polled PR is enriched with its review timeline, persisted to `code_pr_review` keyed on GitHub's own review id (so a backfill re-walk and a later incremental poll converge on one row rather than inflating `reviewer_load`). `PENDING` reviews are dropped: they are the reviewer's unsent draft, visible only to them, so counting one would credit a review nobody has received. The collector derives `first_review_at` and `approved_at` from the timeline — **first**, not last, because a later re-review after changes must not erase how long the original wait was. `merged_by` comes free on the PR detail response already being fetched, and `self_merge_rate` needs both it and the approvals (an author merging their own *approved* PR is normal practice, not a governance gap). **A failed reviews request yields `undefined`, never `[]`** — "merged with no review" is a reportable finding, so it must never be manufactured from a 500; `undefined` also leaves any previously-collected timeline intact. This makes one unit of `PR_ENRICH_BUDGET_PER_TICK` cost **3 API calls** (detail + commits + reviews); see §12 #14 for the org-scale implication.
- **PR commit subjects.** Neither the PR list endpoint, the PR detail call, nor the `pull_request` webhook payload carries a PR's commit messages — only `GET /repos/{repo}/pulls/{number}/commits` does. They are one of the three documented Jira-key sources (§6), so a PR whose key appears only in its commits was a permanent orphan while title and branch were the only inputs. The poller now fetches them alongside the stats call, which makes **one unit of `PR_ENRICH_BUDGET_PER_TICK` cost 2 API calls rather than 1** — the budget still counts PRs made whole per tick, not requests. One page (100) is fetched: GitHub caps the endpoint at 250 anyway, and a PR needing more than 100 commits to mention its key once isn't worth a second round-trip. A failed commits call yields an empty list, which is indistinguishable from a PR whose commits carry no key and correctly produces no extra match — the PR still lands with its title/branch evidence. PRs orphaned before this existed are re-matched in-DB by `POST /admin/configurations/correlation/reconcile-orphans` (§6) once a later sync fills their messages in.
- **PR line-change stats.** Same gap, same fix, for pull requests: GitHub's PR list endpoint never includes `additions`/`deletions`/`changed_files` either — only `GET /repos/{repo}/pulls/{number}` does. The poller enriches each polled PR the same way (bounded per-tick budget, `PR_ENRICH_BUDGET_PER_TICK`), deferring any PR the budget doesn't reach to a later tick rather than locking in missing stats. In steady-state (incremental) sync this means the watermark (`Connection.syncCursors.prNewestSeenAt`) only advances once every PR newer than it has actually been enriched that tick — never past a PR the budget didn't reach, or it would be skipped forever. Unlike commits, the `pull_request` **webhook** payload already includes these fields directly (no separate detail call needed there).
- **Commit timestamps.** `authoredAt` (`commit.author.date`) and `committedAt` (`commit.committer.date`) both come from the same list-endpoint response (no extra call) and can differ — a rebase, cherry-pick, or amend changes `committedAt` without touching `authoredAt`. `push`-webhook payloads carry only one timestamp per commit, so `committedAt` is set equal to `authoredAt` there.
- **Connection config keys consumed by the sync:** GitHub — `repoFullName` (required), `backfillSince` (optional ISO date); Jira — `siteUrl`, `email` (required), `projectKey` (optional JQL filter), `backfillSince` (optional ISO date), plus the collector-resolved `sprintFieldId` / `storyPointsFieldIds` caches below.
- **Jira's own `created` date is collected, because ours is not a substitute.** `created` is in `BASE_SEARCH_FIELDS` and lands on the work-item event as `sourceCreatedAt` → `story.source_created_at`. The row's own `createdAt` is insertion time — for a backfilled tenant, the day the backfill ran — so `lead_time` computed from it reports the age of our database rather than the age of the work (METRICS.md `lead_time`). Items collected before this field was requested keep a null `source_created_at` and are excluded from lead time rather than estimated. **Repairing them needs the reconciler, not a re-walk** (§9): the idempotency key is derived from the issue's `updated` timestamp, so re-collecting an unchanged issue produces the same key and is dropped as a duplicate before the projector ever sees it.
- **Jira issues carry their status-transition timeline.** The search requests `expand=changelog` (a comma-separated **string**; this endpoint rejects an array with `400 Invalid request payload`), so each issue arrives with its own change log and no per-issue call is needed. Status changes are extracted into `transitions[]` on the work-item event and appended to `issue_status_history` — the basis for cycle_time, wip/wip_age, flow_efficiency, blocked_time and aging_work_items, none of which are derivable from the current status alone. A change log can occasionally come back truncated (`changelog.total` exceeding the entries returned); only those issues fall back to `GET /rest/api/3/issue/{key}/changelog`, and a failed fallback keeps the partial history rather than discarding the timeline. Each transition is keyed on the source's own changelog id, so replays de-dupe instead of inflating durations. The issue's `statusCategory` (`new`/`indeterminate`/`done`) is captured alongside, because status *names* are per-project and unbounded — flow metrics must classify on the category.
- **Jira custom fields are resolved per site, and a failed lookup is never cached.** Sprint and story points have no stable field id on Jira Cloud — they are per-site custom fields (e.g. `customfield_10020`), so the collector resolves them once via `GET /rest/api/3/field` and caches the result on `connection.config`. Two consequences worth knowing: (1) `getFields` returns `null` on failure rather than an empty catalog, so a transient 401/429 cannot be cached as "this site has no sprint field" — which would silently disable sprint and story-point collection forever; (2) story points resolve to a **list** of candidate ids, because a site that has both a team-managed ("Story point estimate") and a classic ("Story Points") field typically populates only one, and which one varies per project — each issue is read from the first candidate it actually sets. Note the literal ids `storyPoints`, `epic`, and `epicKey` are *not* requested: they are Server/classic-era names that Jira Cloud v3 silently ignores, so they only ever produced undefined values. Epic linkage comes from `parent` instead.
- **Backfill window is admin-configurable.** `admin/configuration` exposes a `backfillDays` field (github/jira, optional — defaults to 90) that resolves to `backfillSince = now - backfillDays` at save time (§9). Changing `backfillDays` (or, for github, `repoFullName` — the connection's collection *target*) on an existing connection clears `Connection.syncCursors`, so the sync re-walks from the new floor instead of a since-completed backfill silently ignoring a widened/narrowed window forever. Saving with the window *unchanged* does **not** recompute `backfillSince` or touch cursors — it's resolved once per distinct value, not re-derived from "now" on every save (which would otherwise drift the floor forward on each unrelated edit).
- **Sync interval is admin-configurable, per source.** `admin/configuration` exposes a `syncIntervalMinutes` field (github/jira, optional — defaults to **240 = 4 hours**, `DEFAULT_SYNC_INTERVAL_MINUTES`) carried straight into `Connection.config.syncIntervalMinutes`. Unlike `backfillDays`, this is read live on every tick rather than resolved to an absolute value — a change takes effect on the very next tick, no cursor reset needed. A connection with no prior sync (`lastSyncAt` null) is always due immediately, regardless of the configured interval — so first backfill still starts within 5 minutes of a connection being created/enabled.
- Page budgets are presently fixed constants in each collector, not yet environment-tunable (only the sync interval is, per the point above).

---

### 3.2 Unattended backfill (`BackfillSchedulerService`)

The reconcilers in §9 run themselves to completion on a **10-minute cron**, one bounded batch per source per tenant per tick. Filling a 2,500-PR history no longer means calling an endpoint a dozen times by hand and re-running whatever the hourly limit cut short.

Two properties make an unattended loop safe, and neither is optional:

- **Every reconciler terminates.** A row stops being a candidate once it has been *asked about* — `pull_request.reviews_fetched_at`, `pull_request.detail_fetched_at`, `story.source_created_at` — not once it has been successfully *filled*. Some rows can never be satisfied: a PR with a genuinely empty diff stays at 0/0/0, and one merged by a since-deleted account has `merged_by: null` forever. Without the asked-about marker those rows stay candidates permanently — harmless for a hand-run endpoint, an unbounded API drain on a schedule.
- **It stops while quota remains.** Bulk runs halt at a **reserve** (`GITHUB_BACKFILL_RATE_RESERVE`, default 1000 requests) read from `X-RateLimit-Remaining`, rather than spending down to zero. Backfill is never what a user is waiting on; the scheduled sync is. This is not hypothetical — a manual backfill run exhausted the hourly limit on a real tenant and every subsequent sync tick returned rate-limited until the reset.

A run that stops reports `resumeAt`, and the scheduler holds a per-tenant cooldown until then rather than spending a request to rediscover it has none. The two stops are kept distinct in logs and results: `reserved` means we chose to stop with quota left; a bare rate limit means GitHub cut us off and the poller has already been starved.

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

Correlation only ever runs **once**, at PR-ingestion time — nothing re-triggers it later. A PR ingested before the Jira story it references exists becomes a **permanent** orphan otherwise. Story lookup is a plain key lookup with **no time window**, so a PR arriving weeks after its story links exactly as well as one arriving seconds after: what matters is arrival *order*, never lag.

### 6.1 Why the order goes wrong during backfill (and the sweep that fixes it)

The two collectors walk history in **opposite directions**:

| Source | Ordering | Collected first |
|---|---|---|
| GitHub | `sort=updated&direction=desc` | **newest** PRs |
| Jira | `ORDER BY updated ASC` | **oldest** stories |

They converge from opposite ends, so GitHub's first pages are the newest PRs — which reference exactly the stories Jira reaches **last**. The orphan-producing order is therefore structural during a joint backfill, not incidental, and it appears precisely where intuition says a slower GitHub should be safe. (On a real tenant this left 50 `unknown_project` orphans, 28 of which matched immediately once the stories had landed.)

A second case no ordering fixes: Jira's floor is `updated >= backfillSince`, so a story finished and untouched before that floor is never collected at all, and a PR referencing it orphans permanently.

**`CorrelationSchedulerService` sweeps every tenant's unresolved orphans on a 30-minute cron**, which closes the race by construction instead of depending on an admin noticing. It is pure in-DB matching (no external calls, so the collector boundary is untouched), idempotent, per-tenant, and one tenant's failure never aborts the sweep for the rest. The manual endpoint remains for on-demand runs.

### Internal event-type families
Normalized `event_type`s are grouped by domain context (source-agnostic): `planning.*` (BC-3), `code.*` (BC-4), `ci.*` (BC-6), `quality.* / security.*` (BC-7). The same family is produced regardless of which source (GitHub vs GitLab vs ADO) emitted it.

---

## 7. Connection lifecycle (onboarding)

Tenants connect a source through the Admin app (BC-2/BC-0), not by operating any external tool. For GitHub/Jira today that's the `admin/configuration` screen (§9) rather than a dedicated connections UI — `POST /api/admin/connections` still exists for direct/manual registration (other sources, multiple repos, etc.), but there is no dedicated frontend page for it yet.

> **Saving the GitHub configuration collects ONE repository** — `${organization}/${defaultRepo}`. The `organization` field is otherwise consumed only by the org-wide sync. That is a genuine trap: an admin fills in "Organization", saves as active, and the connection summary reports "Collecting" — every signal on screen implies the whole org is in scope when one repo is. **Because the org sync's result is Connection rows in that deployment's own database, it does not travel with a deploy**: an environment running identical code collects nothing extra until the sync is run there. `admin/configuration` now carries a **"Sync all repositories in this organisation"** button (calling `POST /admin/configurations/github/sync-org`, §9) plus explicit copy stating the one-repo scope, so the action is discoverable rather than API-only.

1. **Authorize:** OAuth app flow / install the GitHub App / paste a Jira/ADO token. Credentials stored by secret reference.
2. **Register connection:** creates a `connection` (BC-0) with `tenant_id`, `source_system`, scopes, and a webhook secret — for github/jira, saving `admin/configuration` as active does this automatically once the identifying fields are complete (§9).
3. **Subscribe webhooks:** the collector registers webhooks with the source (or instructs the admin) pointing at `/webhooks/{source}`.
4. **Initial backfill:** the scheduled sync sweep imports history; cursors initialized (§3).
5. **Steady state:** webhooks (real-time) + the scheduled sweep (reconciliation) run continuously; health/lag surfaced back on the same config screen via `connection.status`/`lastSyncAt`.

### 7.1 Sync status & scheduler observability

`GET /api/admin/connections/sync-status` (admin role, tenant-scoped) aggregates current collector/connection state into what the admin **Sync Status** screen (`/admin/sync-status`) shows, broken out **per source** (GitHub and Jira are separate sections — they sync and are configured independently, §3): per-connection backfill progress and ingested volume/date coverage (from the raw-event log, so it's accurate uniformly across event types), whether that source's tick is mid-sweep right now with a rough ETA, the connections whose one-time historical backfill has completed, and the **recent run history** — what synced, when, how long it took, and whether it succeeded.

- **Backfill completion** is tracked per-connection via `Connection.backfillCompletedAt` — set once, the first time a connection's `collection_mode` flips from `backfill` to `poll` (§3). It is never cleared or recomputed afterward: changing `backfillDays`/`repoFullName` and re-walking from a new floor (§9) does **not** reset it — a connection's first-backfill completion is a permanent, one-time fact.
- **Scheduler tick state** lives in one `SchedulerTick` row per source (`id` = `"github"` / `"jira"`), upserted by `CollectorSchedulerService.tick()` at the start of every sweep (`startedAt`, `totalConnections` = due connections this tick), incremented after each connection actually polled (`connectionsProcessed`), and closed out at the end (`finishedAt`). The reported ETA is a rough extrapolation (`elapsed ÷ connectionsProcessed-so-far × connections-remaining`), not a scheduling guarantee. `totalConnections` counts only connections that were **due** (§3) — a tick with nothing due still runs (and finishes near-instantly) but reports `0`.
- **Run history** is tenant-scoped: one `ConnectionSyncRun` row per connection per tick it was actually polled (`running` → `success`/`error`, with `eventsFetched`/`eventsIngested` and, on failure, a truncated `errorMessage`). Connections skipped because they weren't yet due get no row. The Sync Status screen shows each source's most recent 20 runs, newest first.
- Read-only observability over existing collector/connection state — it does not itself call any external source API (consistent with §0: only the Collector context talks to source systems).

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
  - **`syncIntervalMinutes` (optional number, both namespaces, independent per source):** how often that source polls for changes — defaults to 240 (4 hours) if left blank. Unlike `backfillDays`, carried straight into `Connection.config` and read live on every tick (§3) — no rescoping/cursor-reset semantics apply.
  - **Secret values can be pasted directly, for any `secret-ref` field in any namespace** (not just github/jira) — `PUT` accepts an optional `secretValues: { [fieldKey]: string }` alongside `secretRefs` (the ref *name*, unchanged) and an optional `clearSecrets: string[]` (field keys whose stored value to delete). A value is rejected with `400` if no ref name is set for that field yet. Values are encrypted (`SecretsService`, AUTH-AND-RBAC.md §7) and **never** appear in any response or audit entry — omitting a field from `secretValues` leaves its stored value (if any) untouched, so a save that only edits an unrelated field never wipes a previously-pasted secret. Every config response includes `secretsConfigured: { [fieldKey]: boolean }` (is a value stored in the DB for this field) and the catalog response includes `secretsStoreEnabled: boolean` (is `SECRETS_ENCRYPTION_KEY` configured server-side at all) so the UI can explain itself instead of failing opaquely.
- Read-heavy: metrics series, dashboard widgets, risk feed, delivery-graph queries, agent chat.
- Current dashboard metrics endpoint: `GET /api/dashboards/metrics?metrics=pr_cycle_time,loc_added_deleted,bug_count&groupBy=repo|project|developer|day&repos=&projects=&from=&to=` returns tenant-scoped rows with metric cells, sample sizes, and `computedAt`. Developer grouping is activity context, not a productivity ranking — rows grouped by developer are returned and rendered **alphabetically**, never ordered by volume.
- **`GET /api/catalog/sprints`** accepts `state` as a comma-separated set (e.g. `active,closed`). Sprint Health and Sprint Risk use it to keep unstarted sprints out of the picker (§12 #24).
- **`GET /api/catalog/developers`** returns `lastActiveAt` per developer — newest commit across every identity they commit under. The list stays alphabetical (it is a searchable picker), but boards use this to *open* on someone with recent work rather than whoever sorts first; on the reference tenant only 36 of 83 developers committed in the last week, so an alphabetical default landed on an empty board more often than not.
- **`GET /api/dashboards/sprint-health/active`** and **`/sprint-risk/active`** return `{ rows, stale[], staleGraceDays }`. `stale` holds sprints Jira still calls active whose end date is more than `staleGraceDays` past (§12 #24, DASHBOARDS.md §4.1.2).
- **`GET /api/dashboards/project-activity`** returns `truncated: boolean` — true when the commit read hit its ceiling, so the totals cover only the most recent part of the window (§12 #26).
- **Developer-scoped reads resolve identity first.** `GET /api/dashboards/developer-activity?developer=` and `GET /api/catalog/developers` key on a **canonical developer id**, not a raw git/GitHub login (§12 #22, DATA-MODEL.md §3). The activity response carries `identity: { logins, recoveredEmails, inferred }` naming the source identities its figures were gathered under, and `totals.prsMerged` alongside `totals.prsAuthored` — Delivery Explorer counts merged PRs by merge date while this board counts every PR opened in the window, and the two are only comparable when both are stated. The catalog returns `{ login, displayName, attributed }`; `attributed: false` marks a developer with collected commits but no matched GitHub account, who is selectable rather than hidden.
- **Commit-counting reads disclose attribution coverage.** `GET /api/dashboards/project-activity` returns `attribution: { commitsInScope, commitsAttributed, commitsUnattributed, coveragePct, unattributedIdentities }` and each row carries `unattributedCommits`. Those commits are counted in `commits`/`locChanged` but cannot be counted in `contributors`, so without the disclosure a row reports more work than people to do it.
- **Data reconcilers** (admin role, tenant-scoped). Each fixes facts *already persisted*, writing domain rows directly rather than re-ingesting — the deliberate exception to the event-sourced path, because an idempotency key makes a fact permanent once first ingested, so a corrective re-ingestion is dropped as a duplicate before any projector sees it. **They also run unattended** on a 10-minute cron (`BackfillSchedulerService`, §3.2); the endpoints below remain for an immediate kick.
  - `POST /admin/configurations/github/reconcile-commit-stats` — line-change stats for commits still at 0/0/0.
  - `POST /admin/configurations/github/reconcile-pr-stats` — the same for pull requests.
  - `POST /admin/configurations/jira/reconcile-story-dates` — `story.source_created_at` for work items collected before Jira's `created` was requested (§3, METRICS.md `lead_time`). Batches 100 issues per request via `key in (...)`, so a 13k-item tenant costs ~130 calls rather than 13,000. An issue Jira no longer returns (deleted, or moved out of view) stays null rather than being guessed, and a failed batch leaves its rows as candidates for a re-run instead of being recorded as "has no created date".
  - `POST /admin/configurations/github/reconcile-reviews` — review timelines for PRs ingested before reviews were collected. **The regular sync will never reach these**: steady-state PR sync only walks PRs newer than `syncCursors.prNewestSeenAt`, and every already-ingested PR sits behind that watermark. One API call per PR, bounded at 500 per invocation, resumable — re-run until `remaining` is 0. A failed request leaves the PR a candidate rather than stamping an empty timeline as fact.
  - `POST /admin/configurations/correlation/reconcile-orphans` — re-attempts PR↔story matching; pure in-DB, no external calls. **Also runs on a 30-minute cron** (`CorrelationSchedulerService`), see §3.1.
  - `POST /admin/configurations/correlation/resolve-identities` — rebuilds the developer identity map: links the git identities a person commits under to the GitHub account their PRs carry (§12 #22, DATA-MODEL.md §3). Pure in-DB, no external calls, idempotent, and **also on the same 30-minute cron** — a developer is unresolvable until their first PR supplies a login, so re-deriving on a schedule is what turns a new joiner's back-catalogue of commits from nobody's into theirs. Returns `{ observed, resolved, recovered, unresolved, ambiguous }`.
- **Data freshness:** `GET /api/dashboards/freshness` (tenant-scoped, dashboard roles) returns `{ lastSyncAt, staleSeconds, neverSynced, failing[], sources[] }` — how current the collected data actually is (METRICS.md §9). It is its own endpoint rather than a field on each read model: freshness is a property of collection, not of any one metric, so threading it through every view would add identical queries per endpoint for the same tenant-wide answer. `lastSyncAt` is the **oldest** successful sync across the tenant's *active* connections, because a board mixes Jira and GitHub facts and the freshest source says nothing about the number beside it. Never-synced connections (data absent, not stale) and failing ones (frozen at an unknown age — a rejected pass still stamps `lastSyncAt`, §3) are reported separately rather than folded into the timestamp. Disabled connections are excluded, since a deliberately-off source isn't expected to be current. **`computedAt` on the metric/insight responses is when the query ran and is not a freshness signal.** The frontend renders this on every board through the shared Scope Bar.
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

**Resolving anything in §12 updates its row in the same session** — status, date, and the pointer to where it now lives. A gap register that lags the code is worse than none, because it is read as current.

---

## 12. Jira + GitHub MVP implementation status

The known gaps between this contract and the code, for the two MVP sources. "Open" means the behavior is specified here or in [METRICS.md](../features/METRICS.md) but not implemented — treat those specs as forward-looking, not as descriptions of today.

| # | Gap | Source | Status | Notes |
|---|---|---|---|---|
| 1 | `lead_time` measured from the row's insert date, not Jira's `created` | Jira | **Done** 2026-08-12 | `story.source_created_at` (§3); items without one are excluded and counted, never estimated. Already-collected rows repaired by `POST /admin/configurations/jira/reconcile-story-dates` (§9) — a re-walk cannot, see below. METRICS.md `lead_time` |
| 2 | Webhook receivers: connection routing, Jira signature verifier, provider-side registration | Both | **Deferred** 2026-08-12 | Poll-only MVP by decision. §2 and §7 step 3 describe the target, not current behavior — the receiver can't be reached from a real provider (routing depends on a header neither GitHub nor Jira Cloud can set on a subscription) |
| 3 | `webhookSecretRef` configurable in `admin/configuration` for both namespaces but consumed by nothing | Both | Open | Follows from #2 — hide or label the field so onboarding doesn't imply real-time works |
| 4 | Data freshness reported as query time (`computedAt: new Date()`), not the newest contributing event | Both | **Done** 2026-08-12 | `GET /api/dashboards/freshness` (§9) + a note on every board via the Scope Bar. Reports the **oldest** sync across active connections, with never-synced and failing connections called out separately. `computedAt` stays what it always was — when the query ran |
| 5 | PR reviews not collected — no `pr_review` entity, no reviews fetch | GitHub | **Done** 2026-08-12 | `GET /pulls/{n}/reviews` per enriched PR → `code_pr_review` + `first_review_at`/`approved_at`/`merged_by` (§3). One enrich-budget unit is now **3 API calls**. Delivers review_coverage, time_to_first_review, review_time, merge_time, self_merge_rate, reviewer load |
| 13 | `review_depth` / `rubber_stamp_rate` — no per-review comment counts | GitHub | **Done** 2026-08-12 | `GET /pulls/{n}/comments` attributes each comment to its `pull_request_review_id` (4th per-PR call). `pr_review.comments_counted` gates the metric so an uncounted zero never becomes a rubber-stamp finding, and `rubber_stamp_rate` only asks the question of PRs over a size threshold |
| 15 | Correlation orphans from backfill ordering — nothing re-ran the match | Both | **Done** 2026-08-12 | `CorrelationSchedulerService`, 30-min per-tenant cron (§6.1). The two collectors walk history in opposite directions, so the race is structural, not incidental |
| 26 | Silent read caps: 50-repo default scope and a 2,000-row commit read | Both | **Done** 2026-08-14 | Scope resolution reused the repo picker's first page, so a board with no explicit repo filter measured the alphabetically-first 50 repos and presented it as the whole tenant — a three-quarters truncation at the documented ~200-repo scale. Now `CodeService.listAllRepos` (unpaginated; pagination existed for the picker's UI, not for correctness). The commit read's 2,000-row cap was at ~70% on a 30-day window; raised to 20,000 and paired with an explicit `truncated` flag (fetch limit+1) surfaced on Project Activity, so reaching the ceiling is reported instead of quietly shrinking every total. If it starts tripping, the real fix is aggregating in SQL rather than loading rows |
| 25 | Three different date conventions across the boards | Frontend | **Done** 2026-08-14 | Scope Bar sent a rolling `now − days×86400000`, activity boards bucketed IST calendar days, Productivity bucketed weeks on the UTC Sunday, and `groupBy=day` keyed on UTC. "Last 7 days" meant three different ranges depending on the board. All unified on IST calendar alignment via `istWindowFloor`/`istDateKey`/`istWeekKey` (DASHBOARDS.md §4.1.1) |
| 24 | Sprints Jira still calls active, and unstarted sprints in the picker | Jira | **Done** 2026-08-14 | Jira never auto-closes a sprint; one on the reference tenant had been `active` for 4+ years and rendered permanently as a live card. Active sprints more than 14 days past `endAt` are now split out and reported separately rather than ranked or hidden (DASHBOARDS.md §4.1.2). The picker requests `state=active,closed`, and sprint ordering specifies `nulls: 'last'` — Postgres sorts NULL first on a DESC sort, so a dateless `future` sprint was arriving at the top of the list |
| 23 | Backend image could not migrate itself, and its Prisma engine could not load | Deploy | **Done** 2026-08-13 | Surfaced by shipping #22, which is the first change in a while to carry a schema migration. The runtime stage copied only `dist/` — no `prisma/`, so no migrations — while `prisma` was a devDependency stripped by `npm ci --omit=dev`, so the compose `migrate deploy` override could never have run. Separately, `node:20-alpine` ships no libssl, so Prisma's native engines failed to load at all, reporting it as `Could not parse schema engine response` — that broke every query, not just migrations. Image now installs `openssl`, ships `prisma/`, and boots via `npm run start:prod` (`migrate deploy && node dist/main.js`). Verified by booting the built image against an empty database: 18 migrations applied, then the app started (deployment/README.md §3.1) |
| 22 | Developer identity unresolved — commits and PRs by one person counted as two | Both | **Done** 2026-08-13 | GitHub sets `commit.author.login` only when the commit email is **verified** on an account; otherwise the commit lands with a name/email and no login while the same person's PRs always carry `user.login`. Reads filtered on the raw login, so Developer Activity showed "0 commits" for people who had been committing all month, while Delivery Explorer showed their merged PRs — the two boards contradicting each other about one person. On the reference tenant this was **19.2% of all commits across 19 git identities**. Fixed by `correlation_developer_identity` (DATA-MODEL.md §3) + `DeveloperIdentityService`: resolution ladder is source login → verified-email match → unique normalized name↔login, with ambiguity queued as an orphan and never merged. Recovered **15 of 19** identities on real data, 0 ambiguous; the rest stay honestly unattributed and are now selectable rather than invisible. `POST /admin/configurations/correlation/resolve-identities` (§9) applies it on demand; the 30-min correlation sweep keeps it current |
| 21 | Org-wide collection was API-only, while the UI implied it was already happening | Frontend | **Done** 2026-08-13 | Saving GitHub config creates one connection (`org/defaultRepo`) yet the "Organization" field and a green "Collecting" banner implied org-wide scope; `sync-org` had no UI trigger at all. Diagnosed from a real split: local had 15 `athmahealth/*` connections from a past sync-org run, the hosted deployment had none, on identical code — the sync result is DB rows, so it never travels with a deploy (§7) |
| 20 | Scope controls rendered on boards that ignore them | Frontend | **Done** 2026-08-13 | Velocity, Forecasting and Flow send `projects` only, yet showed Repositories, Time range and Group by — controls that looked like filters and changed nothing. `ScopeBar` now takes `showRepos`/`showTime`/`showGroupBy`; those three render projects only (DASHBOARDS.md §4). Forecasting has no repository dimension at all — filtering it by repo would drop every unlinked story and make the forecast wrong, not narrower |
| 19 | Org-scale sweep starved the backlog — no ordering, overlapping ticks | Both | **Done** 2026-08-13 | Surfaced by onboarding a 195-repo org. Connections now swept neediest-first (`lastSyncAt ASC NULLS FIRST`) and a running sweep blocks the next (§3). Config alone could not fix it: a connection still backfilling is always due regardless of `syncIntervalMinutes` |
| 18 | Reconcilers were manual and stopped dead at the rate limit | Both | **Done** 2026-08-12 | `BackfillSchedulerService` drives them to completion on a 10-min cron with a per-tenant cooldown, stopping at a rate reserve so bulk work can't starve the poller (§3.2). Required adding `pull_request.detail_fetched_at` first: without an asked-about marker, rows GitHub can never satisfy would be re-fetched every tick forever |
| 17 | PR conversation comments not collected — `rubber_stamp_rate` sees only inline comments | GitHub | Open | `GET /pulls/{n}/comments` returns diff-anchored comments; review discussion in the PR conversation is `GET /issues/{n}/comments`, a separate endpoint. A team that reviews in the conversation tab scores as rubber-stamping — on a real tenant this read **97.9%**. Until collected, the metric is presented as "worth a look", never as proof (METRICS.md `review_depth`) |
| 16 | Reviews unreachable for already-ingested PRs (behind the sync watermark) | GitHub | **Done** 2026-08-12 | `POST /admin/configurations/github/reconcile-reviews` (§9) + `pull_request.reviews_fetched_at` as the explicit "we asked" marker, so "no reviews" and "never asked" stop being the same absence |
| 14 | Per-PR enrichment cost vs. org-scale rate limits | GitHub | **Done** 2026-08-12 | Per-tick budgets are env-tunable (`GITHUB_PAGE_BUDGET_PER_TICK`, `GITHUB_COMMIT_ENRICH_BUDGET_PER_TICK`, `GITHUB_PR_ENRICH_BUDGET_PER_TICK`), and bulk backfill now stops at a rate **reserve** (`GITHUB_BACKFILL_RATE_RESERVE`, default 1000) so it can never starve the scheduled sync (§3.2). A PR still costs 4 calls; a large org needs the budgets sized per deployment |
| 6 | PR commit messages not collected — correlation matches on title + branch only | GitHub | **Done** 2026-08-12 | `GET /pulls/{n}/commits` per enriched PR (§3). One enrich-budget unit is now 2 API calls, not 1. Already-orphaned PRs resolve via `POST /admin/configurations/correlation/reconcile-orphans` once their messages land (§6) |
| 7 | No `commit_implements_story` edge — commits ingested but never correlated | Both | Open | `pr_implements_story` is the only edge type. Blocks `cycle_time`'s documented first-linked-commit fallback (DATA-MODEL.md §graph) |
| 8 | Sprint scope history (`sprint_scope`, committed-at-start) not modeled | Jira | Open | Committed points are read as *current* sprint membership, so `sprint_commitment_reliability` trends to 100% and `scope_creep` is structurally 0 — wrong by construction, not merely absent |
| 9 | No deletion/move reconciliation | Both | Open | The poller is `updated >=`, so it can only add or update. A deleted or project-moved Jira issue, or a renamed repo, persists and keeps counting |
| 10 | `flow_efficiency` / `blocked_time` need a per-tenant status classification | Jira | Open, deliberate | Documented in METRICS.md. Costs `sprint_health` 35 of its 100 weight |
| 11 | DORA family — no Actions/deployment/build collection | GitHub | Open | Horizon 1 promises "DORA-lite" (PRODUCT-ARCHITECTURE.md §7, §14 Phase 1); none of it exists yet |
| 12 | Global metric exclusions (bot accounts, merge commits, draft PRs, reverts) | Both | **Partly done** 2026-08-12 | Bot exclusion implemented for reviews via `pr_review.is_bot`, classified from GitHub`s `user.type` with the `name[bot]` login as fallback (METRICS.md §0). **Still open:** commit/author side, merge commits, reverts, draft PRs, and per-tenant configurability — these are code-level defaults today, not `metric_definition` rows |
