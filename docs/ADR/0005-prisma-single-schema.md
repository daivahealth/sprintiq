# ADR-0005: Prisma ORM, single schema with table-prefix context boundaries

- **Status:** Accepted
- **Date:** 2026-06-30
- **Supersedes:** [ADR-0004](0004-data-access-and-tenancy.md)
- **Deciders:** Chief Software Architect, Founding Engineering
- **Related:** [DATA-MODEL.md](../architecture/DATA-MODEL.md), [ADR-0001](0001-modular-monolith-first.md), [security/AUTH-AND-RBAC.md](../security/AUTH-AND-RBAC.md)

## Context

[ADR-0004](0004-data-access-and-tenancy.md) selected TypeORM with a physical Postgres schema per bounded context. It weighed multi-schema/raw-SQL ergonomics for the delivery graph but **under-weighted organizational consistency**: every other project in this org uses **Prisma**. A single ORM across projects means one mental model, shared patterns, faster review and onboarding, and reusable tooling — a strong, durable reason that outweighs the theoretical graph ergonomics (Prisma supports `$queryRaw` and `Unsupported`/raw access for graph traversal and `pgvector` when those land).

Prisma centralizes the schema in one client, which is in mild tension with "each context owns a physical schema." We resolve that by choosing the **single-schema + table-prefix** model rather than Prisma's `multiSchema`.

## Decision

**Use Prisma over PostgreSQL. One Postgres schema (`public`); bounded-context separation is logical via table-name prefixes. Row-level tenancy via `tenantId` is preserved unchanged.**

1. **ORM: Prisma** (`@prisma/client` + `prisma` CLM). Single `prisma/schema.prisma`, single generated client exposed via a global `PrismaService` (NestJS pattern). Migrations via `prisma migrate`.
2. **Logical context boundaries via table prefixes.** Each model maps (`@@map`) to a prefixed table name reflecting its context — e.g. `identity_user`, `connections_connection`, `collectors_raw_event`, `code_pull_request`, `correlation_link`, `metrics_value`, `planning_story`, `audit_log`. There is no physical Postgres schema per context.
3. **No cross-context foreign keys.** References across contexts use internal IDs through the owning context's service/events — not Prisma relations across context boundaries. This keeps the extraction path open even without physical schemas (ADR-0001).
4. **Row-level tenancy unchanged.** Every domain table carries `tenantId`; indexes lead with it; the `TenantContextService` (AsyncLocalStorage) remains the single enforcement point; isolation is tested.
5. **IDs.** Internal surrogate keys are ULIDs (string, time-sortable), generated in application code (`newId()`) and passed on create — Prisma has no native ULID default. External source IDs are stored as received (VARCHAR), never the primary key.
6. **Connection string.** Prisma reads a single `DATABASE_URL` (replaces the discrete `DATABASE_*` vars).

## Consequences

**Positive**
- Consistency with every other project in the org — the dominant reason.
- Excellent DX: typed client, `prisma migrate`, `prisma studio`, schema-as-single-source-of-truth.
- Simplest mental model; matches existing team muscle memory (e.g. the `athma-edge` PrismaService pattern).

**Negative / costs**
- **Physical schema-per-context boundary is dropped.** Extraction of a context to its own database becomes a bit more manual (move prefixed tables) than lifting a whole schema. Mitigated by: consistent table prefixes, **no cross-context FKs**, and repository/service discipline enforced in review.
- A single Prisma client is shared across modules — a mild coupling at the data-access layer. Acceptable; the domain boundaries live in the module/service structure, not the client.
- ULID requires code-side id generation (no Prisma default); enforced because models declare `id` without a default, so creates must supply it.
- Graph traversal / `pgvector` use `$queryRaw` rather than a query builder; isolated to the correlation/knowledge contexts.

**Mitigations**
- Table-prefix naming convention documented in `prisma/schema.prisma` and DATA-MODEL.md; lint/review guards against cross-context Prisma relations.
- `prisma migrate` is the only schema authority; a first throwaway-dev spin may use `prisma db push`.
- Tenant-isolation test helper required for any new data path (per `CLAUDE.md`).

## Alternatives considered

- **TypeORM + physical schema-per-context (ADR-0004)** — superseded: inconsistent with the org's Prisma standard; the consistency cost outweighs the multi-schema benefit.
- **Prisma `multiSchema` (physical schemas)** — considered and not chosen: preserves the physical boundary but adds setup/operational complexity; the team preferred the simpler single-schema + prefix model. Can be revisited if a context's extraction pressure makes physical isolation worthwhile (would warrant a new ADR).
- **Database-per-tenant** — out of scope here; remains available for enterprise single-tenant/regional deployments (architecture §17). Default stays row-level `tenantId`.
