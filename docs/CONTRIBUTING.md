# Contributing to SprintIQ Documentation

Writing standards and contribution guidance for the `docs/` tree. Agent operating rules are in [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md); this file is about *how to write the docs well*.

## Principles

1. **Documentation-First.** A change that affects architecture, APIs, the collector/ingestion contract, metrics, rules, agents, security, or operations updates the right doc *in the same change* — not as follow-up.
2. **One canonical home.** Before creating a file, find the existing doc that should absorb the change. Prefer updating over adding. No summary/status/completion files.
3. **No drift, no duplication.** Don't restate the same content across families. Link instead. If code and docs disagree, reconcile or explicitly flag the mismatch.
4. **Authoritative source of truth.** [PRODUCT-ARCHITECTURE.md](architecture/PRODUCT-ARCHITECTURE.md) is the master. Other docs *derive from* and *link to* it; they don't contradict it.

## Routing (where does my change go?)

| Change | Family |
|---|---|
| Bounded contexts, delivery graph, data model, system design | `architecture/` (+ `ADR/` if a decision/boundary changes) |
| API shape, endpoint semantics, auth/signature, **collector webhook/ingestion contract** | `api/` |
| Feature behavior, metric/rule/agent definitions, dashboards | `features/` |
| Local setup, commands, coding patterns | `development/` |
| Docker, Kubernetes, collector/deployment ops | `deployment/` |
| Auth, RBAC, multi-tenancy, audit | `security/` |
| Operational procedures, troubleshooting | `runbooks/` |

## Style

- Lead with *what it is* and *why it matters*, then detail. Write for a busy engineer or CTO.
- Use tables for entities/fields/options; diagrams (ASCII is fine) for flows and relationships.
- Keep IDs/contracts precise; mark examples as examples.
- Relative links between docs; reference architecture sections by name (e.g., "§11 Integration").
- Prefer present tense and active voice. Be concise; cut restatement.

## ADRs

Significant or hard-to-reverse decisions get an ADR (`ADR/NNNN-title.md`) using **Status · Context · Decision · Consequences · Alternatives**. ADRs are immutable once Accepted — supersede, don't rewrite. See the [ADR index](ADR/README.md).

## Definition of done (docs)

- Correct family updated; no duplicated content; links valid.
- `CLAUDE.md` and `AGENTS.md` still materially aligned if operating rules changed.
- Any code/doc mismatch discovered is reconciled or explicitly surfaced.
- If the change touches the collector boundary, tenancy, metrics, rules, or agents, the relevant ADR/contract is updated too.
