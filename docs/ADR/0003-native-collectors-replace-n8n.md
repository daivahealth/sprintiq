# ADR-0003: Native NestJS collectors replace n8n for source integration

- **Status:** Accepted
- **Date:** 2026-06-30
- **Supersedes:** [ADR-0002](0002-n8n-ingestion-boundary.md)
- **Deciders:** Chief Software Architect, Founding Engineering, Security
- **Related:** [PRODUCT-ARCHITECTURE.md §11 Integration / §12 Event Flow](../architecture/PRODUCT-ARCHITECTURE.md), [api/README.md](../api/README.md), [ADR-0001](0001-modular-monolith-first.md)

## Context

[ADR-0002](0002-n8n-ingestion-boundary.md) established **n8n** as the sole transport layer: source tools → n8n → SprintIQ's secured ingestion REST API, with n8n forbidden from touching the database. That decision correctly protected the integrity/lineage/tenancy boundary, but it assumed n8n as a given.

On review, n8n is the wrong layer for a **commercial, multi-tenant SaaS** whose integration logic is core product value:

1. **Connectors are product IP and a reliability surface.** Comparable platforms (LinearB, Jellyfish, Sleuth, DX) build and own their integration layer. Pagination, rate-limit backoff, incremental-sync cursors, OAuth/app-installation token refresh, partial-failure handling, and historical backfill are real engineering that belongs in tested, version-controlled, type-safe code — not in workflow JSON.
2. **You cannot reliably ship n8n workflows to every tenant.** A SaaS must onboard tenants by connecting their Jira/GitHub/etc. through a controlled, observable, self-serve flow — not by asking each customer to operate and maintain n8n workflows.
3. **Operational simplicity.** n8n is another stateful system to run, secure, scale, and debug. Folding collection into the NestJS app removes a moving part, simplifies local dev, and gives first-class observability and per-tenant control.
4. **n8n's value here was modest.** Its visual workflows and large connector library don't offset the loss of control for a small, well-defined set of high-value sources we must support deeply anyway.

The genuinely valuable part of ADR-0002 — a **single, secured, idempotent, lineage-preserving ingestion pipeline as the only door for external data** — is independent of n8n and must be preserved.

## Decision

**Build native NestJS collectors for every source system. Remove n8n. Preserve the single-ingestion-pipeline boundary inside the application.**

1. **Collector context (BC-1) owns all external communication — in and out.** No other context may call a source API or receive a source webhook. This replaces "n8n is the only producer" with "the Collector context is the only door."
2. **Each source is an isolated collector** comprising:
   - a **typed API client** (auth via OAuth app / GitHub App installation / PAT, with token storage + refresh),
   - a **webhook receiver** (public HTTPS endpoint, per-provider signature verification),
   - a **scheduled poller** (NestJS Scheduler) for backfill, reconciliation, and sources with weak/no webhooks — handling pagination, rate-limit backoff, and incremental-sync cursors.
3. **Both push and pull converge on one pipeline.** Webhook receivers and pollers both emit the **canonical envelope** into the same internal ingestion pipeline: **verify → idempotency → raw-event store → normalize → domain event**. The raw-event store, idempotency semantics, canonical contract, and lineage from ADR-0002 are retained unchanged.
4. **Per-provider webhook security.** Verify each provider's signature scheme (GitHub `X-Hub-Signature-256` HMAC, GitLab secret token, Jira/Azure DevOps shared secret/JWT, Jenkins/Sonar tokens). Unverified payloads are rejected.
5. **Native outbound notifications.** SprintIQ delivers Slack/Teams/email directly via provider clients/incoming-webhooks (BC-15). The "emit intent → n8n" hop is removed; throttling/quiet-hours/audience resolution still happen in SprintIQ before delivery.
6. **Connection registry (BC-0) holds integration state per tenant:** credentials (by secret reference), webhook secrets, installation IDs, sync cursors, rate-limit budgets, and health.

## Consequences

**Positive**
- Full control over correctness, retries, backfill, and rate limits — in tested, typed, version-controlled code.
- Clean self-serve tenant onboarding (connect an org / install a GitHub App / paste a Jira token) with no customer-side workflow ops.
- One fewer external system; simpler deployment, local dev, and observability; per-tenant collector metrics.
- The integrity/lineage/tenancy boundary survives intact — it was never really about n8n, only about the single ingestion pipeline.
- Collector latency, throughput, and error rates become first-class signals feeding integration-health dashboards.

**Negative / costs**
- **SprintIQ now owns connector maintenance** against API churn across Jira, GitHub, GitLab, Azure DevOps, SonarQube, Jenkins, and Actions. This is ongoing engineering that n8n would have partly absorbed.
- More code to build up front (clients, webhook receivers, pollers, token management, secret storage) before first data flows.
- We must operate public webhook endpoints securely (signature verification, replay protection, abuse/rate controls) — previously n8n's edge.
- Secret management (OAuth/app tokens) is now our responsibility and must be done well (vault/KMS, rotation).

**Mitigations**
- A **shared collector framework** (common client/poller/webhook abstractions, rate-limit + retry + cursor primitives) so each new source is thin and consistent.
- The source-agnostic **canonical envelope** isolates source quirks at the collector edge; the rest of the system is unaffected by provider changes.
- Contract tests per collector against recorded fixtures; idempotent at-least-once + reconciliation pollers heal missed/duplicated webhooks.
- Phase sources by value (Jira + GitHub first), matching the roadmap — we don't build all collectors at once.
- Secrets via vault/KMS by reference, never in plaintext columns or logs (see [security/AUTH-AND-RBAC.md](../security/AUTH-AND-RBAC.md)).

## Alternatives considered

- **Keep n8n as transport (ADR-0002)** — superseded: cannot be shipped per-tenant reliably, scatters connector logic outside the app, and cedes control of a core reliability/IP surface. Its only durable contribution — the single ingestion pipeline — is preserved here without it.
- **Hybrid (n8n for some sources, native for others)** — rejected: two integration paradigms to build, secure, and reason about; doubles the boundary surface for little gain.
- **Third-party unified integration API (e.g., a SaaS aggregator)** — rejected for the core: cost at scale, data-residency/compliance concerns for an enterprise tool, and loss of control over correlation-critical fidelity. Could be revisited for a long tail of low-value sources, but the *boundary* (Collector context, single pipeline) would remain.

## Migration notes

- Remove the top-level `n8n/` directory and n8n workflow references from docs.
- BC-1 is renamed/reframed from "Ingestion Gateway (n8n-facing)" to **"Collectors & Ingestion."**
- The `/api/v1/ingest/*` REST surface is replaced by **internal** ingestion plus **public** webhook-receiver endpoints (`/webhooks/{source}`); the canonical envelope and downstream pipeline are unchanged.
- Outbound notifications move from "→ n8n" to native delivery (BC-15).
- All docs updated in the same change (Documentation-First); ADR-0002 marked Superseded.
