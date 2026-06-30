# ADR-0004: Data access (TypeORM), schema-per-context, and row-level tenancy

- **Status:** Superseded by [ADR-0005](0005-prisma-single-schema.md) (2026-06-30)
- **Date:** 2026-06-30
- **Deciders:** Chief Software Architect, Founding Engineering
- **Related:** [ADR-0005](0005-prisma-single-schema.md), [DATA-MODEL.md](../architecture/DATA-MODEL.md), [PRODUCT-ARCHITECTURE.md §15](../architecture/PRODUCT-ARCHITECTURE.md), [ADR-0001](0001-modular-monolith-first.md), [security/AUTH-AND-RBAC.md](../security/AUTH-AND-RBAC.md)

> **Superseded.** The org standardizes on **Prisma**; SprintIQ aligns with it — see [ADR-0005](0005-prisma-single-schema.md). The durable parts below — row-level `tenantId` tenancy, no cross-context FKs, ULID ids, extraction-friendly boundaries — are preserved by ADR-0005; only the ORM (Prisma, not TypeORM) and the schema model (single schema + table prefixes, not physical schema-per-context) changed.

## Context

The backend scaffold needs three intertwined decisions settled before any persistence code is written: (1) the data-access technology, (2) how bounded contexts share the database without coupling, and (3) how multi-tenancy is enforced at the data layer. The data model ([DATA-MODEL.md](../architecture/DATA-MODEL.md)) already mandates: `tenant_id` on every row, string external IDs, append-only raw events, a delivery graph with typed/scored edges, `pgvector` embeddings, and no cross-context foreign keys.

Constraints that shape the choice:
- **Modular monolith now, extractable later** (ADR-0001) — contexts must be able to move to separate databases with minimal change.
- **Graph + vector workloads** — correlation traverses a graph; BC-12 stores embeddings. We need easy access to raw SQL and `pgvector`, not just a high-level ORM.
- **Strict tenancy** — "no cross-tenant read, ever," tested not assumed.

## Decision

**Use TypeORM over PostgreSQL, with one database schema per bounded context, and row-level multi-tenancy via a `tenant_id` column on every domain row enforced through a shared tenant-context mechanism.**

1. **ORM: TypeORM** (`@nestjs/typeorm`). Rationale: canonical NestJS integration; first-class migrations; multi-schema support; and trivial drop-down to raw/parameterized SQL for the delivery graph and `pgvector` (which an opinionated client-generator ORM makes harder). `synchronize` is **always false** outside throwaway local dev — schema changes go through migrations.
2. **Schema-per-context (not schema-per-tenant).** Each bounded context owns a Postgres schema (`identity`, `connections`, `collectors`, `planning`, `code`, `ci`, `quality`, `correlation`, `metrics`, `rules`, `analytics`, `ai_agents`, `dashboards`, `notifications`, `audit`). This makes a context's tables a clean unit to lift into a separate database on extraction, and prevents accidental cross-context joins.
3. **Row-level tenancy.** Every domain table carries `tenant_id`; composite indexes lead with `tenant_id`. Tenancy is resolved once per request/job into an **AsyncLocalStorage-backed `TenantContextService`** (set by `TenantMiddleware` from the JWT, or by the collector/worker from the connection). A base repository / query helper injects the `tenant_id` filter so individual queries cannot forget it. Isolation tests assert no cross-tenant read path exists.
4. **No cross-context foreign keys.** References across contexts use internal IDs through the owning context's service/events — never a DB-level FK into another schema (keeps extraction cheap, per ADR-0001).
5. **IDs.** Internal surrogate keys are ULIDs (string, time-sortable). External IDs are stored as received (VARCHAR), never re-minted (DATA-MODEL §0).

## Consequences

**Positive**
- Idiomatic NestJS DX (entities, repositories, migrations, request-scoped wiring) with an escape hatch to raw SQL for graph/vector.
- Schema-per-context + no cross-context FKs make the monolith→services split mechanical.
- Centralized tenant context means tenancy is enforced in one place and testable, not sprinkled per query.
- AsyncLocalStorage avoids request-scoped-provider performance pitfalls and works in workers/pollers where there is no HTTP request.

**Negative / costs**
- TypeORM's multi-schema migrations need discipline (one migration set, schema-qualified). Documented in the migration workflow.
- A base-repository tenant filter is a guardrail, not a guarantee — raw SQL must still pass `tenant_id` explicitly; covered by lint guidance + isolation tests.
- `pgvector` needs a custom column type/extension enabled in migrations (deferred until BC-12 lands).

**Mitigations**
- `synchronize:false` everywhere but disposable local dev; migrations are the only schema authority.
- Tenant-isolation test helper shipped with the scaffold; required for any new data path (per `CLAUDE.md`).
- Architecture/import tests forbid importing one context's entities into another.

## Alternatives considered

- **Prisma** (used by the sibling `athma-edge` project) — rejected for SprintIQ: weaker multi-schema story, and graph/`pgvector`/raw-SQL ergonomics are more awkward than TypeORM for this workload. Consistency with a different product didn't outweigh fit.
- **Schema-per-tenant or database-per-tenant** — rejected as the default: thousands of tenants × per-tenant schemas is an operational and migration burden; row-level `tenant_id` with strong enforcement scales better. (Database-per-tenant remains available for enterprise single-tenant/regional deployments — architecture §17.)
- **Raw `pg` + hand-rolled repositories (no ORM)** — rejected for the scaffold: more boilerplate, no migration framework, slower onboarding. We keep raw SQL only where it earns its keep (graph traversal, vector search).
- **A dedicated graph database for the delivery graph** — deferred: Postgres (adjacency tables + recursive CTEs) is sufficient at target scale and avoids a second datastore; revisit if graph queries become the bottleneck (would warrant its own ADR).
