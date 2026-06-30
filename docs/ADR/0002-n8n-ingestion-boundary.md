# ADR-0002: n8n is the transport boundary; no direct database access

- **Status:** Superseded by [ADR-0003](0003-native-collectors-replace-n8n.md) (2026-06-30)
- **Date:** 2026-06-30
- **Deciders:** Chief Software Architect, Founding Engineering, Security
- **Related:** [ADR-0003](0003-native-collectors-replace-n8n.md), [PRODUCT-ARCHITECTURE.md §11 Integration / §12 Event Flow](../architecture/PRODUCT-ARCHITECTURE.md), [api/README.md](../api/README.md), [ADR-0001](0001-modular-monolith-first.md)

> **Superseded.** SprintIQ no longer uses n8n. Source integration is handled by **native NestJS collectors** — see [ADR-0003](0003-native-collectors-replace-n8n.md). This record is retained for history. The durable principle below — *a single, secured, idempotent, lineage-preserving ingestion pipeline as the only door for external data* — is preserved by ADR-0003; only the producer changed (native collectors instead of n8n).

## Context

SprintIQ ingests data from many source systems — Jira (multiple instances), GitHub, GitLab, Azure DevOps, SonarQube, Jenkins, GitHub Actions — and sends outbound notifications to Slack, Teams, and email. The organization already operates **n8n** and intends to use it for all webhook receipt and outbound delivery.

The tempting shortcut is to let n8n write directly to PostgreSQL (n8n has database nodes), since it already receives the webhooks. That would make n8n a de-facto part of the data layer.

This is dangerous for an enterprise, multi-tenant system of insight:

- It scatters **validation, idempotency, tenancy enforcement, and business rules** into n8n workflows — outside the application's tested, audited, version-controlled code.
- It couples the database schema to n8n workflow internals, making schema evolution and service extraction (ADR-0001) hazardous.
- It bypasses **lineage** (raw-event capture, event→metric→risk traceability) and **audit**.
- It creates a second, weaker write path that can violate tenant isolation or insert unvalidated/duplicated data.

## Decision

**n8n is strictly a transport layer. It calls SprintIQ's secured REST APIs and never accesses the database. SprintIQ owns all validation, business rules, metrics, AI, persistence, and decisioning.**

Concretely:

1. **Single ingress: the Ingestion Gateway (BC-1).** All external data enters only through `/api/v1/ingest/*`, which enforces — in this order — timestamp/replay check, HMAC signature verification, API-key→tenant/connection resolution, schema validation, idempotency de-dup, durable raw-event capture, then async normalization. (Contract in [api/README.md](../api/README.md).)
2. **Single egress: the Notification service (BC-15).** Outbound messages leave only as signed *notification intents* posted to n8n; n8n decides *how* to deliver, never *whether* to notify. SprintIQ resolves audience/throttling/quiet-hours before emit.
3. **n8n does light shaping only.** It wraps source payloads in the canonical envelope and adds deterministic idempotency keys. It must not compute metrics, correlate entities, or make decisions.
4. **No database node, credential, or network path from n8n to PostgreSQL.** Enforced by network policy (DB not reachable from n8n), by not issuing DB credentials to n8n, and by code/architecture review.
5. **Tenant is derived from the authenticated credential**, never trusted from the payload body.

## Consequences

**Positive**
- All writes pass one tested, audited, tenant-safe, idempotent path → integrity and **lineage** are guaranteed (every dashboard number traces to a raw event).
- Business logic stays in version-controlled, reviewable application code — not in workflow JSON.
- Source-tool churn is absorbed by n8n + the source-agnostic canonical envelope; the core stays clean and stable.
- The boundary makes service extraction (ADR-0001) safe: ingestion can become its own service without touching n8n's role.
- Security posture is far stronger: one authenticated, signed, rate-limited, replay-protected ingress; no broad DB exposure.

**Negative / costs**
- Slightly more upfront work than "n8n writes to the DB": we must build and maintain the ingestion API and the canonical contract.
- n8n workflows must be kept aligned with the envelope/event-type contract; contract changes require coordinated updates (governed by Documentation-First + this ADR).
- An extra network hop (n8n → gateway) vs a direct DB write — negligible against the integrity/lineage/security gains, and the gateway acks after durable raw persistence so n8n's retry semantics stay simple.

**Mitigations**
- Versioned, documented canonical envelope ([api/README.md](../api/README.md)) so source changes rarely break the contract.
- Idempotent at-least-once semantics + reconciliation/backfill endpoints heal missed/duplicated webhooks.
- Contract tests between representative n8n workflows and the gateway.

## Alternatives considered

- **n8n writes directly to PostgreSQL** — rejected: scatters validation/tenancy/business logic outside the app, breaks lineage/audit, couples schema to workflows, opens a weak second write path, and blocks safe service extraction. This is the explicit anti-pattern this ADR forbids.
- **SprintIQ receives webhooks directly (no n8n)** — rejected for now: duplicates connector/retry/transformation work that n8n already does well across many sources; n8n is an existing, intentional capability. (Could be revisited per-source if a connector needs capabilities n8n lacks, but the *boundary* — secured API ingress, no direct DB — would remain.)
- **Message broker as the external ingress (e.g., Kafka exposed to producers)** — rejected at this stage: heavier to operate and secure for external producers than a signed REST gateway; the internal event bus still exists behind the gateway for async processing.
