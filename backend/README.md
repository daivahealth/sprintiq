# SprintIQ Backend

NestJS **modular monolith** for SprintIQ — the AI-powered Engineering Intelligence Platform. One module per bounded context (see [docs/architecture/PRODUCT-ARCHITECTURE.md](../docs/architecture/PRODUCT-ARCHITECTURE.md)); same image runs as `api`, `collector`, or `worker` via `APP_ROLE` ([docs/deployment/README.md](../docs/deployment/README.md)).

> This is the **scaffold**: cross-cutting plumbing (tenancy, RBAC, audit, events, health) + the BC-1 collector/ingestion shape + module skeletons for every context. Domain logic and migrations are built on top, starting with the Jira+GitHub → correlation → metric vertical slice.

## Quick start

```bash
cp .env.example .env
npm install
# bring up Postgres (+pgvector) and Redis — see ../docs/deployment/README.md
npm run start:dev          # APP_ROLE defaults to api
```

Run a specific role:

```bash
APP_ROLE=api       npm run start:dev   # dashboard BFF + admin + auth  → /api/*
APP_ROLE=collector npm run start:dev   # webhook receivers + ingestion → /webhooks/*
APP_ROLE=worker    npm run start:dev   # pollers, rollups, rules, agents, notifications
```

## Layout (bounded contexts → modules)

```
src/
├── main.ts              # bootstrap; APP_ROLE split
├── app.module.ts        # composes all context modules
├── config/              # env loading + validation, APP_ROLE
├── common/              # tenancy, auth/RBAC, audit, events, filters (cross-cutting)
├── database/            # TypeORM DataSource, schema-per-context (ADR-0004)
├── health/              # liveness/readiness
├── collectors/          # BC-1 native collectors + ingestion pipeline
├── correlation/         # BC-5 delivery graph
├── metrics/             # BC-8 metrics engine
├── rules/               # BC-9 rule & risk engine
├── analytics/           # BC-10 analytics & insight
├── ai-agents/           # BC-11/12 agent runtime + memory
└── modules/
    ├── identity/        # BC-2 tenants, users, RBAC, auth
    ├── connections/     # BC-0 source-system registry & health
    ├── planning/        # BC-3 Jira domain
    ├── code/            # BC-4 Git domain
    ├── ci/              # BC-6 build/release
    ├── quality/         # BC-7 quality & security
    ├── dashboards/      # BC-13 read models / BFF
    ├── notifications/   # BC-15 native delivery
    └── audit/           # BC-16 audit & lineage
```

## Non-negotiables (enforced here)

- **Tenant-scoped everything** — `tenant_id` resolved once into `TenantContextService` (AsyncLocalStorage); repositories filter by it. No cross-tenant reads (ADR-0004).
- **Collectors are the only door** — all source I/O lives in `collectors/`; no other context calls a source API ([ADR-0003](../docs/ADR/0003-native-collectors-replace-n8n.md)).
- **Schema-per-context, no cross-context FKs** — keeps services extractable ([ADR-0001](../docs/ADR/0001-modular-monolith-first.md)).
- **Everything audit-logged**; numbers are lineage-traceable.

## First vertical slice (implemented)

End-to-end proof of the architecture — GitHub/Jira → delivery graph → metric → dashboard:

```
POST /webhooks/github            (BC-1) verify sig → GithubCollector.normalizeWebhook
POST /webhooks/jira                     → canonical envelope → IngestionService
        │                                  (idempotency → raw_event → publish domain event)
        ▼
  EventBus  code.pull_request.* ─┬─► CodeService      → upsert code_pull_request
            planning.issue.*    ─┘   PlanningService  → upsert planning_story
        │
        └─► CorrelationService  → extract Jira key (title/branch/commits)
                                  → link PR→Story (confidence) OR flag orphan
        ▼
GET /api/dashboards/pr-cycle-time?repo=owner/name   (JWT + RBAC)
        → MetricsService.computePrCycleTime → p50/p85 over merged PRs (+ metrics_value lineage)
```

Quick try (after migrating + seeding a tenant/user/connection): log in via `POST /api/auth/login`,
post a GitHub `pull_request` webhook to `/webhooks/github` with header `x-sprintiq-connection: <connId>`
and a valid `X-Hub-Signature-256`, then read the metric endpoint.

## Migrations

`synchronize` is off outside throwaway dev. Use:

```bash
npm run migration:generate -- src/database/migrations/<Name>
npm run migration:run
```
