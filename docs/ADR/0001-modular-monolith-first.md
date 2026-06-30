# ADR-0001: Modular monolith first; extract microservices by measured pressure

- **Status:** Accepted
- **Date:** 2026-06-30
- **Deciders:** Chief Software Architect, Founding Engineering
- **Related:** [PRODUCT-ARCHITECTURE.md §15 Microservice Boundaries](../architecture/PRODUCT-ARCHITECTURE.md), [ADR-0003](0003-native-collectors-replace-n8n.md) (collector boundary; supersedes ADR-0002)

## Context

SprintIQ is a multi-tenant Engineering Intelligence Platform spanning ~17 bounded contexts (ingestion, planning, code, CI/CD, quality, correlation, metrics, rules, analytics, AI agents, dashboards, …). It must scale to thousands of developers, hundreds of repositories, and many organizations.

Two structural options at the start:

1. **Microservices from day one** — one deployable per context.
2. **Modular monolith** — a single NestJS deployable with strictly bounded, independently-extractable modules.

Microservices-first imposes distributed-systems cost immediately (network calls, partial failure, distributed transactions/sagas, eventual-consistency debugging, multi-repo CI/CD, service discovery, cross-service tracing) before product-market fit and before we know where the real scaling pressure is. At MVP the dominant risk is **getting correlation accuracy and metric trust right**, not horizontal scale.

However, we *do* anticipate genuinely different runtime profiles later — ingestion (spiky, security-sensitive), correlation (CPU-heavy graph building), metrics (compute-heavy aggregation), and AI agents (costly, LLM/vector I/O, strict guardrails). The architecture must not *block* extracting those.

## Decision

**Build SprintIQ as a modular monolith on NestJS + PostgreSQL, with module boundaries that map 1:1 to bounded contexts, and extract services later only when measured pressure justifies it.**

Enabling constraints (mandatory from day one so extraction stays cheap):

1. **One module per bounded context.** Module boundaries are the future service boundaries.
2. **No cross-context database coupling.** A context never reads or writes another context's tables. Cross-context interaction goes through in-process service interfaces and domain events — the same contracts that would become network calls/message topics after extraction.
3. **Event-driven core.** Ingestion → correlation → metrics → rules → agents → notifications communicate via an internal event bus abstraction (in-process now; Redis Streams/Kafka-capable later) so the async backbone survives extraction unchanged.
4. **Tenant scoping is centralized** (guards/middleware), not per-module ad hoc, so it holds across a future split.
5. **Per-context separation** within the shared PostgreSQL database (physical schemas or table-name prefixes — see [ADR-0005](0005-prisma-single-schema.md)), so a context's tables can move to a separate database cleanly.
6. **Extraction order is pre-identified** by expected pressure: `collector-service` → `correlation-service` → `metrics-service` → `ai-agent-service` first (see architecture §15.2).

A context is extracted only when a concrete signal appears (e.g., ingestion CPU/latency saturating shared resources, AI cost/runtime needing isolation, independent scaling or deploy-cadence needs).

## Consequences

**Positive**
- Fastest path to a trustworthy MVP; one deployable, one CI/CD pipeline, simple local dev.
- In-process calls = no network failure modes, easy transactions where a context legitimately needs them, trivial tracing during the highest-iteration phase.
- Because boundaries and event contracts are enforced now, extraction later is mechanical, not a rewrite.

**Negative / costs**
- Requires discipline: it is *physically possible* to reach across contexts in a monolith, so boundary violations must be caught in review/tests (lint rules on imports, architecture tests).
- A single deployable scales coarsely until extraction; one hot context can pressure others until split.
- Shared database needs careful index/tenant hygiene to avoid noisy-neighbor effects across contexts.

**Mitigations**
- Architecture/import-boundary tests fail the build on cross-context DB access.
- Per-context table separation + tenant-leading composite indexes.
- Observability per context (latency, throughput, cost) so extraction triggers are data-driven, not guesswork.

## Alternatives considered

- **Microservices from day one** — rejected: premature distributed-systems tax, slows the work that actually de-risks the product (correlation + metric trust), multiplies ops surface before scale demands it.
- **Unstructured monolith** (no enforced boundaries) — rejected: fast initially but congeals into a big ball of mud; extraction later becomes a rewrite, and context coupling would violate the tenancy/lineage guarantees.
- **Serverless/functions** — rejected for the core: long-lived event processing, stateful correlation/graph work, and per-tenant cost governance fit a stateful service better; cold-start and orchestration overhead don't pay off here.
