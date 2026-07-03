# Architecture Decision Records (ADRs)

This directory records significant architecture decisions for SprintIQ — the *why* behind structural choices, so future contributors don't relitigate settled questions or unknowingly violate a deliberate constraint.

## What belongs here

An ADR is warranted when a decision:

- changes a bounded-context boundary or the integration boundary (e.g., the collector/ingestion contract),
- selects or rejects a foundational technology or deployment topology,
- establishes a cross-cutting constraint (tenancy, lineage, AI grounding, metric ethics),
- or is expensive to reverse.

Routine, easily-reversible choices do **not** need an ADR.

## Format

Each ADR follows: **Status · Context · Decision · Consequences · Alternatives considered**. Status is one of `Proposed | Accepted | Superseded by ADR-NNNN | Deprecated`. ADRs are immutable once Accepted — supersede rather than edit.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-modular-monolith-first.md) | Modular monolith first; extract microservices by measured pressure | Accepted |
| [0002](0002-n8n-ingestion-boundary.md) | n8n is the transport boundary; no direct database access | Superseded by 0003 |
| [0003](0003-native-collectors-replace-n8n.md) | Native NestJS collectors replace n8n for source integration | Accepted |
| [0004](0004-data-access-and-tenancy.md) | Data access (TypeORM), schema-per-context, row-level tenancy | Superseded by 0005 |
| [0005](0005-prisma-single-schema.md) | Prisma ORM, single schema with table-prefix context boundaries | Accepted |
| [0006](0006-identity-and-tenant-resolution.md) | Global-unique email identity; tenant resolved from the JWT | Accepted |
| [0007](0007-vite-spa-over-nextjs.md) | Frontend stays a Vite SPA (Next.js evaluated and declined) | Accepted |

## Conventions

- Number sequentially, zero-padded (`0003-...`).
- Filename: `NNNN-kebab-case-title.md`.
- Link related ADRs and the relevant sections of [PRODUCT-ARCHITECTURE.md](../architecture/PRODUCT-ARCHITECTURE.md).
- Per Documentation-First policy, an architecture- or boundary-changing PR adds/updates an ADR in the same session.
