# SprintIQ Deployment & Collector Operations

Authoritative reference for how SprintIQ is deployed (Docker for dev, Kubernetes for staging/production) and how the **native collectors** are operated — public webhook ingress, scheduled pollers, secrets, scaling, and integration health.

> Context: [PRODUCT-ARCHITECTURE.md](../architecture/PRODUCT-ARCHITECTURE.md) (§11 Integration, §15 Microservice Boundaries), [ADR-0001](../ADR/0001-modular-monolith-first.md) (modular monolith first), [ADR-0003](../ADR/0003-native-collectors-replace-n8n.md) (native collectors), [api/README.md](../api/README.md) (webhook + polling contract), [security/AUTH-AND-RBAC.md](../security/AUTH-AND-RBAC.md) (secrets). Operational *procedures/troubleshooting* live in `docs/runbooks/`; this doc covers *topology and operational design*.

---

## 1. Topology overview

SprintIQ ships as a **modular monolith** (one NestJS deployable) plus its data stores. The same image runs in three roles via configuration, so the monolith can scale horizontally without being split prematurely (ADR-0001):

| Role | Process | Responsibility |
|---|---|---|
| **api** | NestJS HTTP | Dashboard BFF (BC-13), admin, auth — end-user traffic. |
| **collector** | NestJS HTTP + workers | Public webhook receivers (`/webhooks/{source}`) + ingestion pipeline (BC-1). |
| **worker** | NestJS (no public HTTP) | Scheduled pollers, rule sweeps, metric rollups, agent jobs, notifications (M17, BC-8/9/11/15). |

> In dev, all three roles run in **one process**. In production they are the **same image with different `APP_ROLE`** so they scale independently — the cheapest form of separation before true service extraction. Extraction order when pressure demands it: `collector-service` → `correlation-service` → `metrics-service` → `ai-agent-service` (architecture §15.2).

```
                 Internet
        ┌────────────┴─────────────┐
        ▼                          ▼
  Source webhooks            End users (browser)
  (Jira/GitHub/…)                  │
        │  TLS                     │ TLS
        ▼                          ▼
┌─────────────────┐        ┌─────────────────┐
│ Ingress / WAF   │        │ Ingress         │
│ /webhooks/*     │        │ /api/*          │
└───────┬─────────┘        └───────┬─────────┘
        ▼                          ▼
   collector pods               api pods
        │                          │
        └──────────┬───────────────┘
                   ▼
        ┌──────────────────────┐     ┌───────────────┐
        │ PostgreSQL (+pgvector)│     │ Redis         │
        │ raw events, domain,   │     │ queues, poll  │
        │ graph, metrics, vector│     │ sched, rate-  │
        └──────────────────────┘     │ limit, cache  │
                   ▲                  └───────────────┘
                   │
              worker pods  ── pollers/rollups/rules/agents/notify ──► source APIs + Slack/Teams/email
```

External egress (source API polling + outbound notifications) originates from **collector/worker** pods only — never from `api`.

---

## 2. Dependencies

| Component | Purpose | Notes |
|---|---|---|
| **PostgreSQL 16+ with `pgvector`** | System of record for raw events, domain facts, delivery graph, metrics, embeddings | Single schema, table-prefix context boundaries + no cross-context FKs (ADR-0005) so contexts can still split to separate DBs later. |
| **Redis** | Queues (ingestion/normalize/agent jobs), poller scheduling locks, rate-limit budgets, cache | Required (not optional) once collectors run at scale — needed for distributed scheduling + rate-limit state. |
| **Secret store (Vault/KMS/cloud secrets)** | Source credentials, webhook secrets, JWT signing keys, LLM keys | Secrets referenced, never stored in DB columns or env files in prod. |
| **Object storage (optional)** | Report exports, large raw-payload overflow | Per cloud. |
| **LLM provider** | AI agents (BC-11) | Per-tenant cost governance; keys via secret store. |

---

## 3. Local development (Docker Compose)

```bash
docker compose up -d        # api (all roles in one), postgres (+pgvector), redis
# then:
cd backend && npm install && npm run start:dev    # or rely on the api container
cd frontend && npm install && npm run dev
```

Compose stack: `sprintiq-api` (runs all roles), `postgres` (pgvector image), `redis`. No external automation tool is part of the stack (collectors are native).

**Testing webhooks locally:** expose the collector port via a tunnel (e.g., a dev HTTPS tunnel) and register that URL as the webhook target in a Jira/GitHub sandbox, **or** drive the poller against a sandbox connection for pull-only testing. Per-provider signature secrets are set as dev env vars; never use production secrets locally.

---

## 4. Production (Kubernetes)

Manifests live under `deploy/` (Helm/Kustomize). Recommended shape:

- **Deployments:** `sprintiq-api`, `sprintiq-collector`, `sprintiq-worker` — same image, different `APP_ROLE`; independent HPA.
- **Ingress:**
  - `/webhooks/*` → collector service, fronted by **WAF + TLS**; tight body-size limits; per-source path routing; rate limiting at the edge (defense-in-depth — signature verification still happens in-app, see §6).
  - `/api/*` → api service, TLS, standard auth.
- **CronJobs / scheduler:** poller cadence, reconciliation, rollups, digests run in `worker` via the NestJS Scheduler with Redis-based leader election (so only one worker fires a given job).
- **Secrets:** mounted from the cluster secret store / external-secrets operator → references resolved at runtime. No plaintext source credentials in manifests or env.
- **Config:** `ConfigMap` for non-secret config; `Secret`/external-secret for credentials.
- **Network policy:** only collector/worker pods may egress to the public internet (source APIs, Slack/Teams/email). `api` and `postgres` have no outbound internet need.
- **PodDisruptionBudgets + readiness/liveness** so the webhook receiver stays available during rollouts (missed webhooks are healed by pollers, but availability minimizes reliance on that).

### Scaling drivers (what to watch → what to scale)
| Signal | Scale |
|---|---|
| Webhook burst latency / 503s | `collector` replicas + ingestion queue consumers |
| Poll fan-out / backfill backlog | `worker` replicas; stagger poll schedules |
| Metric/rollup or rule-sweep lag | `worker` replicas; consider extracting metrics-service |
| AI cost/latency | isolate `ai-agent` workers; per-tenant budgets |
| DB CPU / connection pressure | read replicas for BFF; extract a context's prefixed tables to its own DB |

---

## 5. Configuration & secrets

Representative environment (names illustrative; resolve secrets by reference in prod):

```bash
APP_ROLE=collector|api|worker        # selects process responsibilities
DATABASE_URL=postgres://…            # per-env; pgvector enabled
REDIS_URL=redis://…
JWT_SIGNING_KEY_REF=secret://…       # BC-2
LLM_API_KEY_REF=secret://…           # BC-11, per-tenant budgets enforced in-app
PUBLIC_WEBHOOK_BASE_URL=https://hooks.sprintiq.io   # used when registering source webhooks
SECRETS_PROVIDER=vault|aws-kms|gcp-sm
```

**Source credentials & webhook secrets** are **not** global env — they are **per-tenant, per-connection** records in BC-0 (`connection.secret_ref`, `connection.webhook_secret_ref`) pointing into the secret store. Rotation updates the referenced secret without code change. See [security/AUTH-AND-RBAC.md §7](../security/AUTH-AND-RBAC.md).

---

## 6. Collector operations

### 6.1 Inbound webhooks
- **Public, signature-verified endpoints** `/webhooks/{source}`. Verification happens **in the application** (per-provider scheme — GitHub `X-Hub-Signature-256`, GitLab token, Jira/ADO secret/JWT, Sonar HMAC, Jenkins token); the WAF/edge rate-limit is defense-in-depth, not a substitute.
- **Ack after durable raw-persist** (`202`), then normalize asynchronously — keeps provider deliveries fast and within their timeout windows.
- **Idempotency** on `(tenant_id, idempotency_key)` so webhook + poller never double-count.
- **Dead-letter queue** for payloads that fail validation/processing, with alerting (BC-0/16) and replay from the raw store.

### 6.2 Scheduled pollers
- Run in `worker` on the NestJS Scheduler with **Redis leader election** (one firing per job across replicas).
- **Per-connection cursors** (BC-0 `sync_cursors`) advance each poll; **rate-limit budgets** (Redis) prevent tripping source API limits; **backoff** on 429/secondary limits.
- **Cadence defaults:** high-churn entities (issues/PRs) minutes→hourly; full inventory (projects/repos) daily; reconciliation sweeps periodic. Stagger across tenants/connections to smooth load.
- **Backfill** on new connections runs as bounded, resumable paginated jobs.

### 6.3 Integration health
Surfaced from BC-0 → admin dashboard (architecture §9.7): connection status, last-sync, ingestion lag, linkage coverage, DLQ depth, rate-limit headroom, webhook delivery failures. Alerts fire on broken connections, lag thresholds, and DLQ growth.

---

## 7. Data, backup & retention

- **PostgreSQL:** automated backups + PITR; the **raw-event store is the replay source of truth** — protect it (it lets you recompute graph/metrics after logic changes). Retention/archival policy configurable per tenant (compliance).
- **Redis:** treated as ephemeral (queues / cache / rate-limit state); durable cursors live in PostgreSQL (BC-0), so Redis loss degrades throughput but does not lose data.
- **pgvector embeddings:** rebuildable from source content; backed up with the DB.
- **Tenant data residency:** single-tenant / regional deployments available for enterprise (architecture §17) — same image, isolated stack per region.

---

## 8. Security posture (deployment-level)

- TLS everywhere; WAF on the public webhook ingress; tight body-size and rate limits.
- Egress restricted to collector/worker pods (network policy).
- Secrets by reference (Vault/KMS); rotation without redeploy; never logged.
- Per-provider webhook signature verification enforced in-app (never trust the edge alone).
- All collected events and outbound deliveries audit-logged (BC-16); no secrets/PII in logs.

---

## 9. Change policy

Any change to deployment topology, the role split, ingress/webhook routing, secret handling, poller scheduling, or scaling model **must** update this document in the same change (Documentation-First per `CLAUDE.md`/`AGENTS.md`), and warrants an ADR if it alters the collector boundary or the monolith→services extraction plan. Operational step-by-step procedures belong in `docs/runbooks/`.
