# SprintIQ Documentation

Canonical documentation for **SprintIQ** — the AI-powered Engineering Intelligence Platform. Start here to navigate.

> Operating rules for AI/code agents live in the repo root: [`CLAUDE.md`](../CLAUDE.md) and [`AGENTS.md`](../AGENTS.md). They define the Documentation-First policy and the non-negotiable engineering constraints. Read them before contributing.

## Read this first

- [architecture/PRODUCT-ARCHITECTURE.md](architecture/PRODUCT-ARCHITECTURE.md) — **the master product & system architecture** (vision, bounded contexts, AI agents, metrics, dashboards, rule engine, integration, phasing, positioning). Authoritative.

## Documentation map

| Family | Path | Contains |
|---|---|---|
| **Architecture** | [`architecture/`](architecture/) | Master architecture, [data model & delivery graph](architecture/DATA-MODEL.md), technical design. |
| **Decisions (ADR)** | [`ADR/`](ADR/) | Architecture decision records — the *why*. See the [ADR index](ADR/README.md). |
| **API & Integration** | [`api/`](api/) | The [collector webhook + polling + notification contract](api/README.md), endpoint semantics, per-provider signature verification. |
| **Features** | [`features/`](features/) | [Metric catalog](features/METRICS.md), [rule/risk pack](features/RULES.md), [AI agent specs](features/AI-AGENTS.md), dashboards. *(grows per module)* |
| **Development** | [`development/`](development/) | [Onboarding](development/DEVELOPER-ONBOARDING.md), local workflow, commands, coding patterns. |
| **Deployment** | [`deployment/`](deployment/) | [Deployment & collector operations](deployment/README.md) — Docker, Kubernetes, ingress, secrets, scaling. |
| **Security** | [`security/`](security/) | [Auth, RBAC & multi-tenancy](security/AUTH-AND-RBAC.md), audit. |
| **Runbooks** | [`runbooks/`](runbooks/) | [Run locally & exercise the slice](runbooks/LOCAL-RUN.md); operational procedures. |

## How the system fits together (one screen)

```
Source tools ◄─webhooks + polling─► Native Collectors (BC-1)
                                                  │ verify sig → idempotency → raw events (replayable)
                          normalize → domain contexts (planning/code/ci/quality)
                                                  │
                          Correlation (BC-5) ──► Delivery Graph  ★moat★
                                                  │
                          Metrics (BC-8) → Rules/Risk (BC-9) → Analytics (BC-10)
                                                  │
                          AI Agents (BC-11) + Memory (BC-12)  → Recommendations (BC-14)
                                                  │
                          Dashboards (BC-13) · Notifications (BC-15 → native → Slack/Teams/email)
                                                  │
                          Audit & Lineage (BC-16) spans everything · Tenancy/RBAC (BC-2) everywhere
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for writing standards. Core rule: **behavior changes ship with their documentation in the same change**, routed to the correct family above.
