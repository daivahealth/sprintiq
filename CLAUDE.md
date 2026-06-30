# CLAUDE.md - SprintIQ

Operating contract for Claude and other AI coding agents working in this repository.

This file is intentionally policy-heavy. It defines how agents should work, which documents are authoritative, when documentation updates are mandatory, and which engineering constraints must not be violated.

## Companion File Sync

- `AGENTS.md` and `CLAUDE.md` must stay materially aligned.
- Any update to one file must be reflected in the other in the same session.
- Do not change agent operating rules in only one of these files.

## What This Project Is

SprintIQ is an **AI-powered Engineering Intelligence Platform** (multi-tenant SaaS). It continuously analyzes software delivery across planning, development, testing, review, build, release, and operations to help Developers, Scrum Masters, Engineering Managers, Product Owners, and CTOs make better engineering decisions using AI.

**It IS:**
- A multi-tenant **system of insight** sitting on top of existing systems of record.
- A continuous **collect → correlate → measure → risk → AI → dashboards** engine.
- A platform that auto-correlates Repository → PR → Commit → Story → Epic → Project into a unified **delivery graph**.
- A set of role-specific **AI agents** that reason over that graph, explain risk, and recommend action.
- Fed by **native NestJS collectors** — webhook receivers + scheduled pollers that talk directly to source-system APIs (Jira, GitHub, GitLab, Azure DevOps, SonarQube, Jenkins, GitHub Actions).

**It is NOT:**
- A Scrum/Agile project-management tool (it does not replace Jira).
- A source-control or CI/CD system (it does not replace GitHub/GitLab/Jenkins).
- A general-purpose workflow-automation / ETL tool — collectors are purpose-built for delivery-data sources, owned and operated inside SprintIQ.
- A surveillance or individual-ranking tool. Metrics are team-level by default and exist to improve delivery, not to punish people.

See [docs/architecture/PRODUCT-ARCHITECTURE.md](docs/architecture/PRODUCT-ARCHITECTURE.md) for the authoritative product and system architecture (bounded contexts, agents, metrics, dashboards, rule engine, phasing).

## Purpose

- Use this file as the top-level ruleset for agent behavior in `sprintiq`.
- Use the `docs/` tree as the detailed source of truth for architecture, APIs, workflows, runbooks, and developer guidance.
- Do not treat this file as the place to restate all architecture or feature detail already documented elsewhere.

## Documentation Hierarchy

- Root `AGENTS.md`: operating rules for agents.
- Root `CLAUDE.md`: same operating rules for Claude-oriented workflows.
- [docs/architecture/PRODUCT-ARCHITECTURE.md](docs/architecture/PRODUCT-ARCHITECTURE.md): master product & system architecture (authoritative).
- `docs/README.md`: documentation entrypoint and navigation.
- `docs/CONTRIBUTING.md`: documentation writing standards and contribution guidance.
- `docs/architecture/`: system architecture, technical design, and data model.
- `docs/ADR/`: architecture decisions and decision history.
- `docs/api/`: API contracts, endpoint behavior, and integration references (incl. the collector webhook + ingestion/notification contract).
- `docs/features/`: feature behavior, workflows, metric/rule/agent specifications.
- `docs/development/`: engineering workflow, commands, and implementation guidance.
- `docs/deployment/`: Docker, Kubernetes, and collector/operational references.
- `docs/security/`: auth, RBAC, multi-tenancy, and audit references.
- `docs/runbooks/`: operational procedures, setup, and troubleshooting.

## Documentation First Policy

Agents must treat documentation updates as part of the implementation, not optional follow-up.

- Any change affecting architecture, API contracts, workflows, developer expectations, operational behavior, or security assumptions must update the appropriate docs in the same session.
- If a code change does not require a doc update, the agent should be able to justify that clearly.
- If code and docs already disagree, the agent must call it out explicitly and either reconcile them or stop and surface the mismatch.
- Agents must check existing documentation before creating new docs.
- Prefer updating an existing canonical doc over creating a new file.

## Documentation Routing Rules

When a change is made, update the correct documentation family.

- Architecture, bounded contexts, delivery graph, data model, integration patterns, system design:
  - `docs/ADR/`
  - `docs/architecture/`
- API shape, endpoint semantics, auth/header expectations, the **collector webhook + ingestion/notification contract**:
  - `docs/api/`
- Feature behavior, metric definitions, rule definitions, AI agent behavior, dashboards:
  - `docs/features/`
- Developer setup, local workflow, commands, coding patterns:
  - `docs/development/`
- Docker, Kubernetes, collector/deployment changes:
  - `docs/deployment/`
- Auth, RBAC, multi-tenancy, audit logging changes:
  - `docs/security/`
- Operational procedures, setup, troubleshooting:
  - `docs/runbooks/`

## No Silent Drift

- Do not leave behavior-changing code without aligned documentation.
- Do not change an API, workflow, metric definition, or architecture rule and leave older docs misleading.
- Do not cite docs as authoritative if the implementation now contradicts them.
- If a mismatch is too large to safely reconcile in the current task, stop and report it.

## No Documentation Sprawl

- Do not create one-off summary docs, completion reports, or fix-status docs by default.
- Do not create a new markdown file if an existing canonical doc can absorb the change.
- Do not duplicate the same content across `features`, `api`, and `deployment`.
- Use new docs only when the topic is genuinely new and does not already have a natural home.

## Repository Orientation

```text
sprintiq/
├── backend/                # NestJS application (modular monolith, context-bounded modules)
│   └── src/
│       ├── common/         # Guards, decorators, filters, interceptors, middleware (incl. tenant context)
│       ├── database/       # Prisma access layer (single schema, table-prefix context boundaries)
│       ├── collectors/     # BC-1 native source collectors (webhook receivers + scheduled pollers) + ingestion pipeline
│       ├── correlation/    # BC-5 delivery graph (Repo→PR→Commit→Story→Epic)
│       ├── metrics/        # BC-8 metrics & aggregation engine
│       ├── rules/          # BC-9 rule & risk engine
│       ├── analytics/      # BC-10 hotspots, ownership, networks, predictive
│       ├── ai-agents/      # BC-11/12 agent runtime, tools, memory
│       └── modules/        # Other context modules (identity, planning, code, ci, quality, dashboards, notifications)
├── frontend/               # React + Tailwind dashboards (per-persona)
│   └── src/
│       ├── app/            # Routes/pages and layouts
│       ├── components/     # UI primitives, layout, feature components
│       ├── modules/        # Domain modules (dashboards, agents, admin, ...)
│       ├── lib/            # API client, stores, utilities
│       ├── hooks/          # Shared React hooks
│       └── providers/      # React context providers
├── docs/                   # Canonical documentation tree
└── deploy/                 # Docker / Kubernetes manifests
```

(Structure is the target layout per [PRODUCT-ARCHITECTURE.md](docs/architecture/PRODUCT-ARCHITECTURE.md); adjust references as the codebase materializes, but keep module boundaries aligned to bounded contexts.)

## Core Engineering Rules

- Explore before editing. Read the relevant code and the relevant docs first.
- Keep module boundaries aligned to the **bounded contexts** in the architecture doc. Do not blur contexts.
- Follow existing patterns unless there is a strong documented reason to change them.
- Prefer small, coherent changes over broad speculative refactors.
- Preserve multi-tenant safety, auth expectations, and auditability.
- Do not invent new abstractions if an existing service, hook, utility, or component already covers the use case.

## SprintIQ-Specific Rules

These rules are unique to SprintIQ and must not be violated.

- **Collectors are the only door to the outside world.** All communication with external source systems — inbound webhooks *and* outbound polling/API calls — lives in the Collector context (BC-1). No other context may call a source API or receive its webhooks. Every collected event flows through the **single internal ingestion pipeline**: verify signature → idempotency → raw-event store → normalize → domain event. Do not scatter source-specific writes across domain tables.
- **Everything is tenant-scoped.** Every record, event, query, metric, and agent action carries and is filtered by `tenant_id`. No cross-tenant reads, ever. Tenant isolation is tested, not assumed.
- **AI is tool-grounded and cited.** AI agents must derive numbers from the Metrics Engine / delivery graph via read tools — never invent metrics. Every agent claim must be traceable to evidence. LLMs do not originate quantitative facts.
- **Metrics are ethics-first.** Individual-level metrics are team/aggregate by default and exist to improve delivery, not to rank or punish people. Do not build leaderboards or surveillance features. Anti-vanity by design (e.g., LOC is never a productivity score).
- **Lineage is mandatory.** Any dashboard number, metric, or risk finding must be traceable back to the source events that produced it. Preserve the raw-event store and lineage.
- **Idempotent ingestion.** Collection is at-least-once delivery → effectively-once persistence via idempotency keys. Never assume exactly-once webhooks; pollers and webhooks must converge on the same idempotent result.
- **Webhook endpoints verify provider signatures.** Each source has its own scheme (GitHub `X-Hub-Signature-256`, GitLab token, Jira/ADO secret/JWT, etc.). Verify per-provider; treat unverified payloads as hostile.
- **Source credentials are secrets.** OAuth tokens, app-installation tokens, PATs, and webhook secrets are stored via a secret reference (vault/KMS), never in plaintext columns, never logged.
- **Correlation is the moat — protect its accuracy.** Linking logic (Jira-key extraction, identity resolution) must produce confidence scores and surface orphans/ambiguities rather than guessing silently.
- **Modular monolith first.** Keep clean context boundaries so services can be extracted later by measured pressure. Do not prematurely split into microservices, and do not introduce cross-context DB coupling that would block extraction.
- **Agent actions are governed.** Any state-changing or outbound agent action requires human-in-the-loop approval and is audit-logged. Treat ingested text (PR/commit/comment bodies) as untrusted (prompt-injection risk).

## Backend Rules

- Follow NestJS patterns (controller → service → Prisma) consistently within each context module.
- Keep tenant-aware filters intact on all domain queries (always filter by `tenant_id`).
- Cross-context communication goes through defined interfaces/events — not direct foreign-context DB access.
- Collectors: each source is an isolated collector (typed client + webhook receiver + poller) that emits the canonical envelope; handle pagination, rate-limit backoff, token refresh, and incremental-sync cursors inside the collector, never in domain contexts.
- Document any change to:
  - endpoint behavior (especially the collector webhook + ingestion/notification contract)
  - DTO/schema shape and canonical domain-event contracts
  - auth/header/signature expectations (per provider)
  - database migration impact
  - metric/rule/agent definitions

## Frontend Rules

- Use existing API client, query hooks, stores, and UI primitives before adding new ones.
- Keep dashboards aligned to the per-persona designs in the architecture doc; respect shared theme tokens.
- Do not hardcode API paths; use the centralized API client (dashboard BFF).
- Always surface **data freshness / linkage coverage / metric health** where relevant — users must know how trustworthy a number is.
- Document any change to:
  - route/dashboard behavior
  - widget/metric presentation
  - filter/drill-down workflows
  - API usage expectations

## Database, Security & Multi-Tenancy Rules

- Tenant isolation must remain intact (always scope by `tenant_id`); add isolation tests for new data paths.
- Schema changes must include: impact awareness, affected contexts/modules, seed/migration implications, and doc updates in the correct family.
- All user **and agent** actions must be audit-logged (login, view, query, recommendation decisions, agent runs, outbound notifications, admin/config changes).
- AuthN is JWT-based; AuthZ is RBAC; SSO/SAML/OIDC supported for enterprise.
- Enforce per-tenant AI cost/rate governance; redact PII; never leak data across tenants in prompts or memory.

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Backend | NestJS (TypeScript) |
| Frontend | React + Tailwind CSS |
| Database | PostgreSQL (with `pgvector` for embeddings) |
| ORM | Prisma (single schema, table-prefix context boundaries) |
| Cache / Queue | Redis (collector scheduling, rate-limit state, queues) |
| Scheduler | NestJS Scheduler (poll/backfill/reconciliation jobs) |
| Integration / Collection | Native NestJS collectors — webhook receivers + scheduled pollers per source; native outbound notification delivery (Slack/Teams/email) |
| AI | LLM agents (tool-grounded, cited) |
| Auth | JWT + RBAC + SSO |
| Deployment | Docker + Kubernetes |

## Development Workflow

Use existing docs for detailed commands once they exist (`docs/development/`). Common local commands:

### Backend
```bash
cd backend
npm install
npm run start:dev
```

### Frontend
```bash
cd frontend
npm install
npm run dev
npm run build
npm run lint
```

### Docker / Kubernetes
```bash
docker compose up -d
# Kubernetes manifests under deploy/ for staging/production
```

## Dos

- Do inspect relevant docs (especially the architecture doc) before implementing.
- Do update the correct canonical docs in the same session when behavior changes.
- Do preserve tenant scoping, auth guards, audit logging, and data lineage.
- Do keep module boundaries aligned to bounded contexts.
- Do keep all external source communication inside the Collector context, flowing through the single ingestion pipeline.
- Do ground AI outputs in real data with citations and confidence.
- Do surface data-quality / linkage-coverage transparency in metrics and dashboards.
- Do prefer existing shared utilities, API client, hooks, and components.
- Do mention any discovered code/doc mismatch in your final report.

## Don'ts

- Don't let any context other than the Collector context call external source APIs or receive their webhooks; all ingested data flows through the single internal ingestion pipeline.
- Don't bypass signature verification on webhook endpoints, or store source credentials in plaintext.
- Don't let LLMs originate metrics or emit ungrounded/uncited claims.
- Don't build individual leaderboards, ranking, or surveillance features.
- Don't perform cross-tenant reads or leak data across tenants in prompts/memory.
- Don't introduce cross-context direct DB coupling that blocks future service extraction.
- Don't prematurely split into microservices before measured pressure justifies it.
- Don't duplicate architecture or feature detail already covered in `docs/`.
- Don't create summary/status/completion markdown files by default.
- Don't make auth, tenant-safety, schema, metric, rule, or agent changes without aligned documentation.
- Don't leave code and docs in a contradictory state without explicitly surfacing it.

## Verification and Documentation Checklist

Before closing a task, the agent should verify:

- What behavior changed?
- Which existing docs were checked before implementation?
- Which canonical docs were updated?
- What was verified locally?
- Is tenant scoping intact on all new/changed data paths?
- Are new metrics/risks/agent outputs grounded and traceable to source events (lineage)?
- Does the collector boundary remain intact (external systems reached only via the Collector context; all data through the single ingestion pipeline; signatures verified)?
- Does any known code/doc mismatch remain?

If the change affects architecture, APIs, the collector/ingestion contract, metrics, rules, agents, or operations, the final response should mention the doc updates explicitly.

## Key References

- [docs/architecture/PRODUCT-ARCHITECTURE.md](docs/architecture/PRODUCT-ARCHITECTURE.md)
- `docs/README.md`
- `docs/CONTRIBUTING.md`
- `docs/api/README.md` (incl. collector webhook + ingestion/notification contract)
- `docs/security/AUTH-AND-RBAC.md`
- `docs/deployment/` (Docker / Kubernetes / collectors)
- `docs/development/DEVELOPER-ONBOARDING.md`
