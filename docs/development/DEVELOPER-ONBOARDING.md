# Developer Onboarding

How to get productive in the SprintIQ codebase. Read the operating contract first: [`CLAUDE.md`](../../CLAUDE.md) / [`AGENTS.md`](../../AGENTS.md), then the [master architecture](../architecture/PRODUCT-ARCHITECTURE.md).

> The codebase is being built out. This guide describes the **target** layout and workflow per the architecture; adjust as modules materialize, keeping module boundaries aligned to bounded contexts.

---

## 1. Mental model (read in this order)

1. [PRODUCT-ARCHITECTURE.md](../architecture/PRODUCT-ARCHITECTURE.md) — vision, the 17 bounded contexts, agents, metrics, rules.
2. [DATA-MODEL.md](../architecture/DATA-MODEL.md) — raw events → domain contexts → **delivery graph** → metrics/risks.
3. [api/README.md](../api/README.md) — the collector webhook + polling + outbound contract (the only external boundary).
4. [ADR-0001](../ADR/0001-modular-monolith-first.md) & [ADR-0003](../ADR/0003-native-collectors-replace-n8n.md) — why the structure is what it is (ADR-0003 supersedes ADR-0002).
5. [security/AUTH-AND-RBAC.md](../security/AUTH-AND-RBAC.md) — tenancy, RBAC, agent governance.

The one-sentence model: **native collectors (webhook receivers + pollers) feed the single ingestion pipeline → events normalize into per-context models → correlation builds the delivery graph → metrics, rules, and AI agents read the graph → dashboards and notifications present and act — all tenant-scoped, all lineage-traced.**

---

## 2. Repository layout (target)

```
sprintiq/
├── backend/   # NestJS modular monolith — one module per bounded context
│   └── src/
│       ├── common/      # guards, tenant-context middleware, interceptors, filters
│       ├── database/    # Prisma access layer (single schema, table-prefix context boundaries)
│       ├── collectors/  # BC-1 native source collectors (client + webhook receiver + poller) + ingestion pipeline
│       ├── correlation/ # BC-5 delivery graph
│       ├── metrics/     # BC-8
│       ├── rules/       # BC-9
│       ├── analytics/   # BC-10
│       ├── ai-agents/   # BC-11/12 runtime, tools, memory
│       └── modules/     # identity, planning, code, ci, quality, dashboards, notifications, audit
├── frontend/  # React + Tailwind per-persona dashboards
├── docs/      # this tree
└── deploy/    # Docker / Kubernetes manifests
```

---

## 3. Local setup

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
npm run dev      # dev server
npm run build    # production build
npm run lint
```

### Full stack (Docker)
```bash
docker compose up -d        # api, db (PostgreSQL + pgvector), redis
```

Kubernetes manifests for staging/production live under `deploy/`.

---

## 4. Working in a bounded context

- **Stay in your context.** A module owns its tables and logic. Need data from another context? Call its **service interface** or subscribe to its **domain events** — never read another context's tables. (This is what keeps services extractable — ADR-0001.)
- **Controller → service → repository** within each module.
- **Always filter by `tenant_id`.** It's injected by common middleware; the repository layer applies it. Add an isolation test for any new data path.
- **Emit/consume domain events** for cross-context flow (collectors → correlation → metrics → rules → agents → notifications).
- **All source I/O lives in `collectors/`.** Never call a Jira/GitHub/etc. API or add a webhook receiver outside the Collector context. Put pagination, rate-limit backoff, token refresh, and sync cursors inside the collector.

---

## 5. Non-negotiables (will fail review otherwise)

- External systems are reached **only** through the Collector context (BC-1); no other context calls a source API or receives its webhooks ([ADR-0003](../ADR/0003-native-collectors-replace-n8n.md)).
- **Verify provider signatures** on every webhook receiver; **store source secrets by reference** (vault/KMS), never plaintext.
- Everything **tenant-scoped**; no cross-tenant reads; isolation tested.
- AI is **tool-grounded and cited**; LLMs never originate metrics.
- Metrics are **team-level by default**, anti-vanity; no leaderboards/surveillance.
- **Lineage preserved**: any number traces to source events.
- **Idempotent ingestion**; never assume exactly-once webhooks.
- Correlation links carry **confidence**; orphans are surfaced, not guessed.

---

## 6. Definition of done

- Tests pass, including **tenant-isolation** tests for new data paths.
- Tenant scoping, auth guards, and audit logging intact.
- New metrics/risks/agent outputs are grounded and **lineage-traceable**.
- The **collector boundary** is intact (external systems reached only via BC-1; signatures verified).
- Docs updated in the correct family (Documentation-First); `CLAUDE.md`/`AGENTS.md` aligned if operating rules changed.
- Any code/doc mismatch reconciled or explicitly surfaced in your report.

---

## 7. Where things are documented

| Need | Go to |
|---|---|
| Why a structural decision was made | [`docs/ADR/`](../ADR/README.md) |
| The collector webhook / polling / outbound contract | [`docs/api/`](../api/README.md) |
| Entities, keys, the delivery graph | [`DATA-MODEL.md`](../architecture/DATA-MODEL.md) |
| Auth / RBAC / tenancy / agent governance | [`security/`](../security/AUTH-AND-RBAC.md) |
| Feature/metric/rule/agent specs | `docs/features/` (per module) |
| Deploy / infra | `docs/deployment/` |
