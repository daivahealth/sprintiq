# SprintIQ — Product Architecture

**AI-Powered Engineering Intelligence Platform**

| | |
|---|---|
| **Document type** | Master Product & System Architecture |
| **Status** | Foundational — pre-implementation |
| **Audience** | CTO, Principal/Staff Engineers, Product, Founders |
| **Author role** | Chief Software Architect |
| **Version** | 0.1 (architecture baseline) |

> This document defines *what* SprintIQ is and *how* it is structured as a product and a system. It deliberately stops short of table designs and API signatures. It defines business capabilities, bounded contexts, AI agents, metrics, dashboards, the rule engine, integration and event flows, microservice boundaries, phasing, risks, and positioning. Implementation specs (schemas, DTOs, endpoints) are derived from this document in later ADRs.

---

## Table of Contents

1. [Product Vision](#1-product-vision)
2. [Product Capabilities](#2-product-capabilities)
3. [Bounded Contexts](#3-bounded-contexts)
4. [Functional Modules](#4-functional-modules)
5. [AI Agent Architecture](#5-ai-agent-architecture)
6. [User Personas](#6-user-personas)
7. [Product Roadmap](#7-product-roadmap)
8. [Engineering Metrics](#8-engineering-metrics)
9. [Dashboard Design](#9-dashboard-design)
10. [Rule Engine](#10-rule-engine)
11. [Integration Architecture](#11-integration-architecture)
12. [Event Flow](#12-event-flow)
13. [Future Expansion](#13-future-expansion)
14. [Recommended Development Phases](#14-recommended-development-phases)
15. [Suggested Microservice Boundaries](#15-suggested-microservice-boundaries)
16. [Risks](#16-risks)
17. [Assumptions](#17-assumptions)
18. [Product Differentiators](#18-product-differentiators)
19. [Commercial Positioning](#19-commercial-positioning)
20. [Final Architecture Recommendation](#20-final-architecture-recommendation)

---

## 1. Product Vision

### 1.1 One-line vision

> **SprintIQ turns the raw exhaust of software delivery — tickets, commits, PRs, builds, scans, deployments — into continuous, explainable, AI-driven engineering intelligence that helps every role from Developer to CEO make a better decision today than they made yesterday.**

### 1.2 The problem

Modern engineering organizations are data-rich and insight-poor. The signals that explain *why delivery is slow, risky, or fragile* are scattered across Jira, GitHub/GitLab/Azure DevOps, SonarQube, Jenkins, GitHub Actions, and chat tools. Existing dashboards (LinearB, Jellyfish, DX, GitHub Insights) report **what happened** but rarely **why it happened, what will happen next, or what to do about it**. Leaders still rely on gut feel; managers manually stitch reports; developers get judged by vanity metrics like lines of code.

### 1.3 The SprintIQ thesis

SprintIQ is built on four beliefs:

1. **Intelligence, not dashboards.** Charts are a commodity. The differentiator is reasoning: detecting risk early, explaining causality, and recommending action.
2. **Agents over reports.** A reactive dashboard waits to be read. An AI agent watches continuously, reasons over context, and proactively surfaces what matters to *each role*.
3. **Correlation is the moat.** The unique value comes from automatically linking Repository → PR → Commit → Story → Epic → Project across many tools and tenants, producing a unified delivery graph no single tool owns.
4. **Decisions are measurable.** Every recommendation is tracked, accepted/rejected, and its outcome measured — closing the loop between insight and improvement.

### 1.4 What SprintIQ is and is not

**SprintIQ IS:**
- A multi-tenant SaaS **Engineering Intelligence Platform**.
- A continuous **ingestion + correlation + metrics + risk + AI** engine.
- A **decision-support** system with role-specific AI agents and dashboards.
- A **system of insight** that sits on top of existing systems of record.

**SprintIQ is NOT:**
- A Scrum/Agile project-management tool (it does not replace Jira).
- A source-control or CI system (it does not replace GitHub/Jenkins).
- A surveillance tool for ranking or punishing individuals.
- A general-purpose workflow-automation / ETL platform — SprintIQ owns purpose-built **native collectors** for its sources, not generic plumbing.

### 1.5 North-star outcomes

- **Faster, safer delivery:** measurable reduction in cycle time and change-failure rate.
- **Earlier risk detection:** delivery and quality risks surfaced days before a deadline, not after.
- **Better decisions per role:** every persona gets the *one thing* they should act on next.
- **Explainable trust:** every score, risk, and recommendation is traceable to its evidence.

---

## 2. Product Capabilities

Capabilities are grouped into seven capability domains. Each is a *business ability*, independent of implementation.

### C1 — Continuous Data Collection
- Collect engineering events directly from sources via **native collectors** — webhook receivers + scheduled pollers (Jira, GitHub, GitLab, Azure DevOps, SonarQube, Jenkins, GitHub Actions, chat).
- Validate, de-duplicate, and idempotently persist events; webhooks and pollers converge on the same result.
- Reconcile via scheduled backfills/snapshots for missed webhooks; handle pagination, rate limits, and token refresh per source.
- Maintain source-system connection registry (credentials, webhook secrets, sync cursors) and sync health.

### C2 — Entity Correlation & Delivery Graph
- Extract Jira keys from branch names, PR titles, commit messages.
- Link Repository → PR → Commit → Story → Epic → Project → Sprint.
- Resolve developer identities across tools (Git author, Jira account, SSO).
- Maintain a queryable, time-aware **delivery graph** spanning all sources.

### C3 — Metrics & Measurement
- Compute flow, throughput, quality, review, reliability, and people metrics.
- Aggregate across developer / team / repo / project / org / tenant.
- Provide time-series, trend, and benchmark views with historical retention.

### C4 — Risk, Rules & Recommendations
- Configurable rule engine across delivery, code, review, quality, release, capacity, architecture risk families.
- Produce **Risk + Severity + Evidence + Recommendation + Owner**.
- Track recommendation lifecycle and measured outcome (decision feedback loop).

### C5 — AI Engineering Intelligence
- Role-specific AI agents (Scrum Master, EM, Developer, Architecture, etc.).
- Natural-language Q&A over the delivery graph and metrics ("ask your data").
- Narrative generation: sprint summaries, executive briefings, retro inputs.
- Predictive analytics: delivery forecasting, release confidence, risk projection.

### C6 — Analytics & Insight
- Repository hotspots, code ownership, knowledge concentration / bus-factor.
- Collaboration & review networks, dependency risk, technical-debt trends.
- Engineering health, team health, innovation and productivity trends.

### C7 — Presentation, Action & Governance
- Role-based dashboards, drill-downs, filters, and exports.
- Outbound notifications/digests delivered natively (Slack, Teams, email).
- Multi-tenancy, RBAC, SSO, audit, data residency, and configuration.

```
C1 Collect ─► C2 Correlate ─► C3 Measure ─► C4 Risk/Rules ─► C5 AI ─► C6 Analytics ─► C7 Present/Act
        └──────────────────────────  C7 Governance & Tenancy spans all  ──────────────────────────┘
```

---

## 3. Bounded Contexts

SprintIQ is decomposed using Domain-Driven Design. Contexts are classified as **Core** (the competitive moat), **Supporting** (necessary domain logic), and **Generic** (commodity, could be bought/standardized).

### Context map (overview)

```
  Source APIs/webhooks    ┌───────────────────────────────────────────────┐
  (Jira/GitHub/…) ◄──────►│  BC-1 Collectors & Ingestion (Support)         │
   webhooks in + polling  │  (native webhook receivers + scheduled pollers)│
                          └───────────────┬───────────────────────────────┘
                                          │ raw + normalized events
        ┌─────────────────────────────────┼──────────────────────────────────┐
        ▼                                 ▼                                  ▼
┌───────────────┐              ┌──────────────────┐              ┌────────────────────┐
│ BC-3 Planning │              │ BC-4 Source       │              │ BC-6 Build/Release │
│ (Jira) Core   │              │ Control Core      │              │ & CI/CD  Core      │
└──────┬────────┘              └────────┬─────────┘              └─────────┬──────────┘
       │                                │                                  │
       └──────────────►┌────────────────────────────────┐◄────────────────┘
                       │ BC-5 Correlation & Delivery     │   BC-7 Quality & Security (Core)
                       │ Graph  ★CORE / MOAT★            │◄──┘
                       └───────────────┬─────────────────┘
                                       │ unified delivery graph
        ┌──────────────────────────────┼───────────────────────────────┐
        ▼                              ▼                                ▼
┌────────────────┐        ┌───────────────────────┐        ┌────────────────────────┐
│ BC-8 Metrics   │        │ BC-9 Rules & Risk Core │        │ BC-10 Analytics & Insight│
│ Engine  Core   │───────►│                        │◄───────│  Core                    │
└───────┬────────┘        └───────────┬────────────┘        └────────────┬────────────┘
        │                             │                                  │
        └───────────────►┌────────────────────────────────┐◄────────────┘
                         │ BC-11 AI Agent Orchestration ★CORE★            │
                         │    + BC-12 Knowledge & Memory (Support)        │
                         └───────────────┬─────────────────┘
                                         │
       ┌──────────────────────────────────┼──────────────────────────────┐
       ▼                                  ▼                               ▼
┌────────────────┐          ┌──────────────────────┐         ┌──────────────────────┐
│ BC-13 Dashboards│         │ BC-14 Recommendations │         │ BC-15 Notifications & │
│ & Reporting Sup │         │ & Decision Loop  Core │         │ Action (native deliv.)│
└────────────────┘          └──────────────────────┘         └──────────────────────┘

  Cross-cutting: BC-2 Identity/Tenancy/RBAC (Generic) · BC-16 Audit & Observability (Generic)
                 BC-0 Source-System Registry & Connection Health (Support)
```

---

### BC-0 — Source-System Registry & Connection Health *(Supporting)*
- **Purpose:** Single registry of every connected source system per tenant and its sync health.
- **Responsibilities:** Store connection metadata (Jira instances, GitHub/GitLab orgs, Azure DevOps, SonarQube, Jenkins endpoints); track last-sync, lag, error rates; expose health to dashboards; hold (references to) credentials/secrets.
- **Inputs:** Admin configuration; heartbeat/health pings; ingestion lag signals.
- **Outputs:** Connection status, sync freshness, integration-health metrics.
- **Interactions:** BC-1 (ingestion), BC-13 (health widgets), BC-15 (alerting on broken integrations).
- **Owner:** Platform / Integrations team.

### BC-1 — Collectors & Ingestion *(Supporting, mission-critical)*
- **Purpose:** The **only** door to the outside world. Owns all communication with external source systems (inbound webhooks *and* outbound polling/API calls) and the single internal ingestion pipeline.
- **Responsibilities:** Per-source **native collectors** = typed API client (OAuth/app-install/PAT auth + token refresh) + **webhook receiver** (per-provider signature verification) + **scheduled poller** (pagination, rate-limit backoff, incremental-sync cursors, backfill). Plus the shared pipeline: verify → idempotency & de-duplication → raw-event capture (replayable) → normalization into canonical domain events → ordering/sequencing → dead-letter handling.
- **Inputs:** Source webhooks and polled API responses (Jira/GitHub/GitLab/ADO/Sonar/Jenkins/Actions).
- **Outputs:** Validated canonical domain events on the internal event bus; raw event archive.
- **Interactions:** External source APIs (in/out), all domain contexts (downstream consumers), BC-16 (audit), BC-0 (connection registry/health/secrets).
- **Owner:** Platform / Integrations team.
- **Key rule:** No other context calls a source API or receives its webhooks. Every collected event flows through this single pipeline; no source-specific writes scattered across domain tables.

### BC-2 — Identity, Tenancy & Access *(Generic)*
- **Purpose:** Who can see and do what, across organizations and tenants.
- **Responsibilities:** Multi-tenant isolation, organizations/teams, users, JWT issuance, RBAC roles & permissions, SSO/SAML/OIDC, identity linking hints (SSO ↔ Git ↔ Jira). (Source-system credentials live in BC-0.)
- **Inputs:** Login, SSO assertions, admin role config.
- **Outputs:** Auth context (tenant_id, org, roles, scopes) injected into every request.
- **Interactions:** All contexts (every query is tenant-scoped), BC-5 (developer identity resolution feeds off identity hints).
- **Owner:** Platform / Security team.

### BC-3 — Planning & Work Management (Jira domain) *(Core)*
- **Purpose:** Canonical model of planned work and its lifecycle.
- **Responsibilities:** Projects, Epics, Stories (Story/Bug/Task/Spike), Subtasks, Sprints, boards, statuses, transitions, story points, assignees; status-change history (the basis for flow metrics).
- **Inputs:** Jira events from BC-1; multiple Jira instances per tenant.
- **Outputs:** Work-item state, sprint scope/timeline, status-transition timeline, planning facts.
- **Interactions:** BC-5 (correlation target), BC-8 (velocity/flow), BC-9 (delivery risk), BC-11 (Scrum Master / PO agents).
- **Owner:** Delivery Intelligence team.

### BC-4 — Source Control & Code Delivery (Git domain) *(Core)*
- **Purpose:** Canonical model of code production.
- **Responsibilities:** Repositories, branches, commits, pull/merge requests, reviews, comments, approvals, diff stats (LOC, files changed, churn), CODEOWNERS.
- **Inputs:** GitHub/GitLab/Azure DevOps events from BC-1.
- **Outputs:** PR lifecycle facts, commit/diff facts, review facts.
- **Interactions:** BC-5 (correlation source), BC-7 (quality on diffs), BC-8 (PR/review metrics), BC-10 (hotspots/ownership), BC-11 (Code/Review/Repo agents).
- **Owner:** Code Intelligence team.

### BC-5 — Correlation & Delivery Graph *(Core — the moat)* ★
- **Purpose:** Weave all sources into one time-aware graph linking work to code to delivery.
- **Responsibilities:** Extract Jira keys from branch/PR/commit (regex + heuristics + ML fallback); link Repo→PR→Commit→Story→Epic→Project→Sprint; resolve developer identities across tools; compute confidence scores for links; flag orphan commits/PRs and unlinked stories.
- **Inputs:** Facts from BC-3, BC-4, BC-6, BC-7; identity hints from BC-2.
- **Outputs:** The unified delivery graph; linkage coverage metrics; orphan/ambiguity reports.
- **Interactions:** Consumed by BC-8/9/10/11/13; this is the substrate everything intelligent reads from.
- **Owner:** Core Intelligence team (highest-leverage context).

### BC-6 — Build, Release & CI/CD *(Core)*
- **Purpose:** Model of how code becomes a running release.
- **Responsibilities:** Pipelines/jobs, build outcomes & durations, deployments, environments, releases/versions, change-to-deploy linkage; basis for DORA reliability metrics.
- **Inputs:** Jenkins, GitHub Actions, (Azure/GitLab CI) events from BC-1.
- **Outputs:** Build/deploy facts, deployment frequency, lead-time-to-deploy, failure/restore facts.
- **Interactions:** BC-5 (link deploys to stories), BC-8 (DORA), BC-9 (release risk), BC-11 (Release agent).
- **Owner:** Delivery Reliability team.

### BC-7 — Quality & Security *(Core)*
- **Purpose:** The health of the code itself.
- **Responsibilities:** Static analysis (SonarQube): coverage, code smells, duplication, complexity, quality gates; security findings/vulnerabilities/CVEs/SAST; dependency risk signals.
- **Inputs:** SonarQube + security scanner events from BC-1.
- **Outputs:** Quality scores, coverage trends, vulnerability inventory, quality-gate status.
- **Interactions:** BC-5 (attach to PR/commit/story), BC-8 (quality score), BC-9 (quality/security risk), BC-11 (QA/Security agents).
- **Owner:** Quality & Security Intelligence team.

### BC-8 — Metrics & Aggregation Engine *(Core)*
- **Purpose:** Turn graph facts into trustworthy, comparable measurements.
- **Responsibilities:** Compute all metrics (see §8); roll up across developer/team/repo/project/org/tenant; maintain time-series + snapshots; define metric semantics, windows, percentiles; provide read-optimized aggregates.
- **Inputs:** Delivery graph (BC-5) + domain facts.
- **Outputs:** Metric series, aggregates, benchmarks, composite scores.
- **Interactions:** BC-9 (rules read metrics), BC-10, BC-11 (agents cite metrics), BC-13 (dashboards).
- **Owner:** Metrics & Analytics team.

### BC-9 — Rules & Risk Engine *(Core)*
- **Purpose:** Encode organizational judgment as configurable, explainable rules.
- **Responsibilities:** Evaluate rule conditions over metrics/graph/events; emit Risk (type, severity, evidence, recommendation, owner); support thresholds, windows, suppression, custom rules per tenant; debounce/escalation.
- **Inputs:** Metrics (BC-8), graph (BC-5), events (BC-1).
- **Outputs:** Risk findings + recommendations.
- **Interactions:** BC-11 (agents enrich/triage risks), BC-13 (risk widgets), BC-14 (recommendation lifecycle), BC-15 (alerts).
- **Owner:** Risk Intelligence team.

### BC-10 — Analytics & Insight *(Core)*
- **Purpose:** Deeper, non-obvious structural insight beyond standard metrics.
- **Responsibilities:** Hotspots, code ownership, knowledge concentration/bus-factor, collaboration & review networks, dependency risk, technical-debt trends, predictive delivery, release confidence, innovation/team-health analytics.
- **Inputs:** Delivery graph, metrics, history.
- **Outputs:** Graphs, rankings, forecasts, structural insights.
- **Interactions:** BC-11 (agents reason over analytics), BC-13 (advanced visualizations), BC-9 (feeds risk signals).
- **Owner:** Metrics & Analytics team.

### BC-11 — AI Agent Orchestration *(Core)* ★
- **Purpose:** The intelligence layer — role-specific agents that reason, explain, and recommend.
- **Responsibilities:** Agent registry & routing, tool/function calling into other contexts (read-only by default), prompt orchestration, context assembly (RAG), guardrails, cost/limit governance, human-in-the-loop, conversation sessions.
- **Inputs:** User questions, scheduled triggers, risk findings; data via tools from BC-5/8/9/10.
- **Outputs:** Narratives, answers, recommendations, agent-detected risks, digests.
- **Interactions:** BC-12 (memory/RAG), BC-13 (assistant UI), BC-14 (recommendations), BC-15 (proactive notifications).
- **Owner:** AI / Applied ML team.

### BC-12 — Knowledge & Memory *(Supporting)*
- **Purpose:** Give agents durable, retrievable context.
- **Responsibilities:** Embeddings/vector store, semantic retrieval over graph+docs, per-agent and per-tenant memory, decision history, glossary/ontology, RAG indexing.
- **Inputs:** Delivery graph, metrics, prior recommendations & outcomes, tenant docs.
- **Outputs:** Retrieved context chunks, memory records, embeddings.
- **Interactions:** BC-11 (primary consumer), BC-14 (outcomes feed memory).
- **Owner:** AI / Applied ML team.

### BC-13 — Dashboards & Reporting *(Supporting)*
- **Purpose:** Present intelligence per persona.
- **Responsibilities:** Read-model/query API for dashboards, widgets, charts, drill-downs, filters, saved views, scheduled reports, exports (PDF/CSV), embedding.
- **Inputs:** Metrics (BC-8), analytics (BC-10), risks (BC-9), agent outputs (BC-11).
- **Outputs:** Rendered dashboards, reports, exports.
- **Interactions:** Frontend; reads from all read-side contexts.
- **Owner:** Product / Frontend + BFF team.

### BC-14 — Recommendations & Decision Loop *(Core)*
- **Purpose:** Close the loop between insight and improvement.
- **Responsibilities:** Recommendation lifecycle (proposed → accepted/dismissed/snoozed → acted → outcome measured), ownership/assignment, effectiveness scoring, feedback to agents/memory.
- **Inputs:** Risks (BC-9), agent recommendations (BC-11), user actions.
- **Outputs:** Decision records, effectiveness metrics, training signal.
- **Interactions:** BC-12 (feeds memory), BC-8 (outcome metrics), BC-13 (action center).
- **Owner:** Product / Risk Intelligence.

### BC-15 — Notifications & Action *(Supporting, native delivery)*
- **Purpose:** Push the right insight to the right channel at the right time.
- **Responsibilities:** Subscription/digest preferences, alert routing, throttling/quiet hours, templating; **native delivery** to Slack/Teams/email via provider clients/incoming-webhooks (delivery clients live in the Collector context, BC-1).
- **Inputs:** Risks, recommendations, agent digests, schedule triggers.
- **Outputs:** Delivered notifications (Slack/Teams/email); in-app notifications.
- **Interactions:** BC-1 (outbound delivery clients), BC-9/11/14 (sources).
- **Owner:** Platform / Integrations team.

### BC-16 — Audit & Observability *(Generic, cross-cutting)*
- **Purpose:** Trust, compliance, and operability.
- **Responsibilities:** Audit log of user/agent/system actions, data lineage (which event produced which metric/risk), platform telemetry (latency, ingestion lag, AI cost/usage), SLOs.
- **Inputs:** All contexts emit audit/telemetry.
- **Outputs:** Audit trails, lineage, ops dashboards.
- **Interactions:** All contexts; BC-13 (admin views).
- **Owner:** Platform team.

---

## 4. Functional Modules

Functional modules are the deployable/feature-level groupings that realize the bounded contexts. (Module → primary BC mapping in parentheses.)

| # | Module | Primary BC | What it does |
|---|--------|-----------|--------------|
| M1 | **Collectors & Ingestion** | BC-1, BC-0 | Native per-source collectors (client + webhook receiver + poller), validation, idempotency, raw store, normalization. |
| M2 | **Identity & Admin** | BC-2 | Tenants, orgs, users, RBAC, SSO, connection/credential management, settings. |
| M3 | **Planning Service** | BC-3 | Jira projects/epics/stories/sprints + status history. |
| M4 | **Code Service** | BC-4 | Repos/PRs/commits/reviews/diffs. |
| M5 | **Delivery & CI/CD Service** | BC-6 | Builds, deployments, releases, environments. |
| M6 | **Quality & Security Service** | BC-7 | Sonar/coverage/vulnerabilities/quality gates. |
| M7 | **Correlation Engine** | BC-5 | Jira-key extraction, entity linking, identity resolution, delivery graph. |
| M8 | **Metrics Engine** | BC-8 | Metric computation, rollups, scores, time-series. |
| M9 | **Rule & Risk Engine** | BC-9 | Rule evaluation, risk findings, severity, recommendations. |
| M10 | **Analytics & Insight** | BC-10 | Hotspots, networks, ownership, predictive, debt trends. |
| M11 | **AI Agent Platform** | BC-11 | Agent registry, orchestration, tools, guardrails, chat. |
| M12 | **Knowledge & Memory** | BC-12 | Vector store, RAG, agent memory. |
| M13 | **Recommendation & Decision Center** | BC-14 | Recommendation lifecycle + effectiveness. |
| M14 | **Dashboard & Reporting (BFF)** | BC-13 | Read models, dashboards, reports, exports. |
| M15 | **Notification & Action** | BC-15 | Subscriptions, routing, native outbound delivery (Slack/Teams/email). |
| M16 | **Audit & Observability** | BC-16 | Audit log, lineage, platform telemetry. |
| M17 | **Scheduler** | cross | NestJS scheduled jobs: rollups, rule sweeps, agent runs, reconciliation, digests. |

---

## 5. AI Agent Architecture

### 5.1 Design principles

- **Agents are read-mostly advisors.** They reason and recommend; they mutate SprintIQ state only through governed actions (e.g., creating a recommendation), and external systems only through the Collector context's outbound clients with explicit human approval.
- **Tool-using, not hallucinating.** Agents answer by calling **read tools** into BC-5/8/9/10 (the delivery graph & metrics). Numbers come from the Metrics Engine, never invented by the LLM.
- **Grounded & cited.** Every claim links to evidence (a metric value, a PR, a risk finding). RAG via BC-12 supplies context.
- **Layered.** A common **Agent Runtime** (orchestration, memory, tools, guardrails) underpins specialized **persona agents**. Avoids N bespoke stacks.
- **Governed.** Per-tenant model selection, cost ceilings, rate limits, PII redaction, prompt-injection defenses, and audit of every agent action.

### 5.2 Agent runtime (shared substrate)

```
User / Schedule / Risk trigger
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│  Agent Runtime (BC-11)                                      │
│  1. Router        → pick persona agent + scope (tenant/role)│
│  2. Context build → RAG (BC-12) + structured tool reads     │
│  3. Reason loop   → LLM + tool-calls (read graph/metrics)   │
│  4. Guardrails    → grounding check, PII, cost, injection   │
│  5. Output        → narrative + cited evidence + actions    │
│  6. Memory write  → episodic + decision outcome (BC-12/14)  │
└───────────────────────────────────────────────────────────┘
```

**Tools available to agents (read by default):** `query_delivery_graph`, `get_metric`, `list_risks`, `get_sprint_health`, `get_repo_health`, `get_pr`, `get_story`, `forecast_delivery`, `search_knowledge`. **Governed actions:** `create_recommendation`, `request_notification` (native delivery, human-approved).

**Memory model (per agent, per tenant):**
- *Episodic:* past conversations & analyses.
- *Semantic:* embeddings of graph/metrics/docs (RAG).
- *Decision:* recommendations made and their measured outcomes (the learning signal).
- *Working:* current-session scratch context.

### 5.3 The agents

For each: **Responsibilities · Inputs · Outputs · Interactions · Prompt focus · Memory · Decision-making.**

#### A1 — Scrum Master Agent
- **Responsibilities:** Sprint health, scope-creep, blockers, stale/at-risk stories, standup & retro inputs, sprint forecasting.
- **Inputs:** Sprint scope & status history (BC-3), velocity/flow metrics (BC-8), delivery risks (BC-9).
- **Outputs:** Daily sprint-health narrative, at-risk-story list, predicted completion, retro talking points.
- **Interactions:** EM Agent (escalation), Developer Agent (blocker context), BC-15 (standup digest).
- **Prompt focus:** *"Given this sprint's scope, status history, and velocity, what threatens the sprint goal and what should the team do today?"*
- **Memory:** Per-team sprint patterns, recurring blockers, forecast accuracy.
- **Decision-making:** Forecast completion via historical velocity + remaining scope + flow; flag when commitment probability drops below threshold.

#### A2 — Engineering Manager Agent
- **Responsibilities:** Team delivery health, bottlenecks, capacity/load balance, cross-team dependencies, attrition/burnout signals (workload-based, not surveillance), 1:1 prep.
- **Inputs:** Team metrics, risks, review network, capacity signals.
- **Outputs:** Weekly team-health brief, bottleneck diagnosis, rebalancing suggestions.
- **Interactions:** Scrum Master, Executive, Architecture agents.
- **Prompt focus:** *"Where is my team's flow constrained, who is overloaded, and what one change would most improve delivery?"*
- **Memory:** Team baselines, prior interventions and outcomes.
- **Decision-making:** Compare current vs baseline/benchmark, attribute deltas to bottleneck stages, rank interventions by expected impact.

#### A3 — Developer Agent
- **Responsibilities:** Personal flow (PRs awaiting me, review latency, WIP), context on assigned stories, "what should I do next," PR-readiness hints. Strictly *self-help*, not manager surveillance.
- **Inputs:** Developer's own work items, PRs, reviews, blockers.
- **Outputs:** Personalized to-do/priority, blockers to escalate, focus suggestions.
- **Interactions:** Scrum Master/Code agents.
- **Prompt focus:** *"What is blocking my work and what is the highest-leverage next action for me?"*
- **Memory:** Personal working patterns (private to the developer).
- **Decision-making:** Prioritize by blocking-others, age, sprint-goal criticality.

#### A4 — Architecture Agent
- **Responsibilities:** Structural health — coupling, hotspots, dependency risk, technical-debt trajectory, architectural erosion, modularity.
- **Inputs:** Hotspots/ownership/dependency analytics (BC-10), churn/complexity (BC-7/8).
- **Outputs:** Architecture risk report, refactor candidates ranked by risk×churn, debt trend narrative.
- **Interactions:** EM, Code, Security agents.
- **Prompt focus:** *"Which parts of the codebase are decaying fastest and pose the most delivery/quality risk?"*
- **Memory:** Debt history, prior refactor outcomes.
- **Decision-making:** Risk = f(churn, complexity, ownership concentration, defect density); rank refactor ROI.

#### A5 — Repository Intelligence Agent
- **Responsibilities:** Per-repo health, activity, contributor distribution, branch hygiene, stale branches, repo-level risk.
- **Inputs:** Repo/commit/branch facts (BC-4), repo metrics (BC-8).
- **Outputs:** Repository health score & narrative, hygiene issues.
- **Interactions:** Architecture, EM agents.
- **Prompt focus:** *"How healthy is this repository and what is its biggest structural or process risk?"*
- **Memory:** Repo baselines & trends.
- **Decision-making:** Composite repo-health scoring with anomaly detection on activity.

#### A6 — Code Intelligence Agent
- **Responsibilities:** Commit/diff-level insight — churn, change risk of a specific PR, risky changes, large/complex diffs, rework patterns.
- **Inputs:** Diff stats, churn, complexity, linked story (BC-4/5/7).
- **Outputs:** PR change-risk score, "this change is risky because…" explanations.
- **Interactions:** Review, QA, Architecture agents.
- **Prompt focus:** *"How risky is this change and why?"*
- **Memory:** Historical change-risk vs realized defects (calibration).
- **Decision-making:** Change-risk model from size, churn, hotspot overlap, ownership, test coverage delta.

#### A7 — Review Agent
- **Responsibilities:** Review process health — review latency, reviewer load, rubber-stamping, review coverage, unbalanced review networks.
- **Inputs:** PR review facts, review network (BC-4/10).
- **Outputs:** Review-health insights, bottleneck reviewers, stale-PR alerts.
- **Interactions:** EM, Code, Developer agents.
- **Prompt focus:** *"Where is the review process slowing delivery or letting risk through?"*
- **Memory:** Review-latency baselines, reviewer-load patterns.
- **Decision-making:** Detect outliers in latency/load; flag low-scrutiny merges on high-risk diffs.

#### A8 — QA / Quality Agent
- **Responsibilities:** Quality posture — coverage trends, defect density, escaped defects, quality-gate breaches, test effectiveness.
- **Inputs:** Sonar/coverage/quality-gate facts, bug stories (BC-7/3).
- **Outputs:** Quality score narrative, quality risks, coverage-gap callouts.
- **Interactions:** Code, Release, Security agents.
- **Prompt focus:** *"Is quality trending in the right direction, and where is risk leaking into production?"*
- **Memory:** Defect-density baselines, gate-breach history.
- **Decision-making:** Correlate coverage/quality-gate breaches with escaped defects; prioritize quality risks.

#### A9 — Release Agent
- **Responsibilities:** Release readiness & confidence — DORA reliability, change-failure, deploy stability, release risk, go/no-go support.
- **Inputs:** Build/deploy facts (BC-6), quality (BC-7), linked changes (BC-5).
- **Outputs:** **Release confidence score**, blockers to release, post-release stability narrative.
- **Interactions:** QA, Security, Executive agents.
- **Prompt focus:** *"Given everything going into this release, how confident should we be, and what are the risks?"*
- **Memory:** Past release outcomes vs predicted confidence (calibration).
- **Decision-making:** Confidence = f(test coverage of changes, open vulns, change risk, recent failure rate, hotspot involvement).

#### A10 — Security Agent
- **Responsibilities:** Vulnerability posture, unresolved CVEs, risky dependencies, security-gate status, exposure trends.
- **Inputs:** Security/SAST/dependency findings (BC-7).
- **Outputs:** Security risk summary, prioritized vulnerabilities, exposure trend.
- **Interactions:** Release, Architecture, Executive agents.
- **Prompt focus:** *"What is our most urgent security exposure and what should we fix first?"*
- **Memory:** Vulnerability lifecycle, mean-time-to-remediate.
- **Decision-making:** Prioritize by severity × exploitability × reachability (hotspot/usage).

#### A11 — Executive Agent
- **Responsibilities:** Org-wide synthesis for CTO/CEO — engineering health, portfolio/epic progress, investment distribution (feature vs maintenance vs debt), risk landscape, plain-language briefings.
- **Inputs:** All composite scores, portfolio metrics, top risks.
- **Outputs:** Executive narrative, board-ready summary, top-3 risks & actions.
- **Interactions:** Synthesizes from EM, Architecture, Release, Security agents.
- **Prompt focus:** *"In plain business language, how healthy is engineering, where is investment going, and what are the top risks?"*
- **Memory:** Org trend history, prior executive guidance.
- **Decision-making:** Aggregate & weight sub-scores; translate engineering signals into business framing.

#### A12 — Knowledge Agent
- **Responsibilities:** Natural-language Q&A over the delivery graph ("ask your data"), onboarding context, documentation/glossary, cross-agent retrieval service.
- **Inputs:** User questions, the entire graph & metrics via tools, RAG (BC-12).
- **Outputs:** Cited answers, explanations, links to evidence.
- **Interactions:** Backs the chat surface for all personas; serves context to other agents.
- **Prompt focus:** *"Answer the user's question using only retrieved, cited platform data."*
- **Memory:** Org glossary/ontology, frequent questions.
- **Decision-making:** Retrieval-augmented; refuses/▷flags when evidence is insufficient (no hallucinated metrics).

#### A13 — Meta / Orchestrator Agent *(added)*
- **Responsibilities:** Routes requests to the right persona agent, composes multi-agent analyses, deduplicates overlapping findings, enforces global guardrails/budgets.
- **Inputs:** All agent outputs, routing context.
- **Outputs:** Unified, de-conflicted responses; multi-agent briefings.
- **Decision-making:** Intent classification → agent selection → synthesis. (This is the runtime's brain, not a persona.)

### 5.4 Guardrails (apply to every agent)
- **Grounding/citation enforcement** — numeric claims must originate from tool reads.
- **PII & confidentiality** — redaction; no cross-tenant leakage; developer-private data stays private.
- **Prompt-injection defense** — treat ingested text (PR/commit/comment) as untrusted.
- **Cost & rate governance** — per-tenant model tier, token budgets, caching.
- **Human-in-the-loop** — any outbound or state-changing action requires approval.
- **Auditability** — every agent run logged with inputs, tools called, outputs, cost (BC-16).

---

## 6. User Personas

| Persona | Primary goal | Cares about | SprintIQ value | Lead agent |
|---|---|---|---|---|
| **Developer** | Ship without friction | My PRs, blockers, review waits, focus | Personal flow & next-best-action | Developer Agent |
| **Team Lead** | Keep the team flowing | Team WIP, review load, at-risk stories | Bottleneck spotting, load balance | EM / Review |
| **Scrum Master** | Protect the sprint | Sprint health, scope creep, blockers | Forecasts, standup/retro inputs | Scrum Master |
| **Engineering Manager** | Improve team delivery | Flow, capacity, dependencies, health | Diagnosis + interventions | EM Agent |
| **Product Owner** | Deliver the right value | Epic progress, predictability, scope | Delivery forecasts, scope risk | Scrum Master / Exec |
| **CTO** | Org-wide engineering health | Health, risk, investment, DORA | Portfolio intelligence & risk | Executive |
| **CEO / Exec Stakeholder** | Business confidence | Are we on track? top risks? | Plain-language briefings | Executive |
| **Platform/Admin** | Run SprintIQ | Integrations, tenancy, RBAC, cost | Connection health, governance | — |
| **Architect / Staff Eng** | Sustainable systems | Debt, hotspots, dependencies | Structural insight & refactor ROI | Architecture |

---

## 7. Product Roadmap

A vision-level roadmap (the engineering phasing is in §14).

### Horizon 1 — "Trustworthy Intelligence" (MVP → GA)
- Native Jira & GitHub collectors + correlation + delivery graph.
- Core metrics (flow, throughput, review, DORA-lite) + foundational dashboards.
- Rule engine v1 + risk findings.
- Knowledge Agent (ask-your-data) + Scrum Master & EM agents.
- Multi-tenant, RBAC, SSO.
- **Goal:** Replace manual reporting; trusted single source of delivery truth.

### Horizon 2 — "Proactive Intelligence"
- Full agent roster (Code, Review, QA, Release, Security, Architecture, Executive).
- Advanced analytics (hotspots, ownership, networks, debt trends).
- Predictive delivery & release confidence.
- Recommendation & decision loop + effectiveness tracking.
- GitLab + Azure DevOps + SonarQube + Jenkins/Actions integrations.
- **Goal:** From reporting to recommending; agents proactively surface risk.

### Horizon 3 — "Autonomous & Benchmarked Intelligence"
- Cross-tenant (opt-in, anonymized) benchmarking.
- Agent-driven workflows (with approval): auto-draft retros, auto-file risks.
- Custom metrics/rules builder, marketplace of templates.
- What-if simulation & capacity planning.
- Deeper ML models (change-risk, attrition-risk, forecast calibration).
- **Goal:** SprintIQ becomes the org's engineering decision system.

---

## 8. Engineering Metrics

Metrics are organized by family. Each has a **definition, dimensions (developer/team/repo/project/org), and window**. Composite **scores** (0–100) are derived from underlying metrics with documented weights and are always drill-downable to evidence.

### Flow & Delivery (Jira + graph)
- **Velocity** — completed story points per sprint; rolling avg & variance.
- **Throughput** — items completed per period (by type).
- **Cycle Time** — first-commit/in-progress → done; distribution & p50/p85.
- **Lead Time** — created → done (and Lead Time for Changes: commit → deploy).
- **Sprint Commitment Reliability** — committed vs completed.
- **Scope Creep / Churn** — items added/removed mid-sprint.
- **Work-in-Progress (WIP)** — concurrent in-progress items; WIP age.
- **Flow Efficiency** — active time ÷ total time (wait vs work).
- **Blocked Time** — time in blocked/waiting states.
- **Aging Work Items** — items exceeding age thresholds.
- **Planning Accuracy** — estimate vs actual.

### Throughput of Code (Git)
- **PR Throughput** — PRs opened/merged per period.
- **PR Size** — LOC & files changed per PR; large-PR rate.
- **PR Cycle Time** — open → merge (with sub-phases: open→first-review, →approve, →merge).
- **Time-to-First-Review** — PR open → first review.
- **Review Time** — first review → approval.
- **Merge Time** — approval → merge.
- **Commit Frequency / Developer Activity** — commits per period (context, never ranking).
- **LOC Added/Deleted** — with explicit anti-vanity framing.
- **Code Churn** — % of recently written code rewritten (rework signal).
- **Rework Rate** — changes to recently-merged code.
- **Files Changed / Change Spread** — breadth of a change.

### Review Quality (Git)
- **Review Coverage** — % PRs with ≥1 substantive review.
- **Reviewer Load / Distribution** — reviews per reviewer; concentration.
- **Review Depth** — comments per PR; rubber-stamp rate (approve with no comments on large diffs).
- **Self-Merge Rate** — PRs merged by author without review.
- **Review Latency p50/p85** — responsiveness of the review system.

### Reliability / DORA (CI/CD)
- **Deployment Frequency.**
- **Lead Time for Changes** — commit → production.
- **Change Failure Rate** — % deploys causing incident/rollback.
- **Mean Time to Restore (MTTR).**
- **Build Success Rate & Build Duration.**
- **Deploy Stability / Rollback Rate.**

### Quality & Security (Sonar/scanners)
- **Test Coverage & Coverage Trend.**
- **Defect Density** — bugs per KLOC / per story.
- **Escaped Defects** — bugs found post-release.
- **Code Smells / Duplication / Complexity (cyclomatic).**
- **Quality Gate Pass Rate.**
- **Open Vulnerabilities by Severity; Mean-Time-to-Remediate.**
- **Dependency Risk / Outdated Dependencies.**
- **Technical Debt Ratio & Trend.**

### Progress & Predictability
- **Epic Progress** — % complete by points/items + projected completion date.
- **Project/Portfolio Progress.**
- **Milestone/Release Burnup.**
- **Predicted Delivery Date** + confidence interval.
- **Forecast Accuracy** — predicted vs actual (model calibration).

### People & Collaboration (ethics-bound; team-level by default)
- **Developer Activity Index** — contextual activity (never a leaderboard).
- **Collaboration Index** — co-review/co-commit breadth.
- **Knowledge Concentration / Bus-Factor** — ownership concentration risk.
- **Onboarding Ramp** — time-to-first-PR / time-to-productivity for new joiners.
- **Workload Balance** — load distribution across the team.
- **Burnout Risk Signal** — sustained after-hours/over-WIP patterns (team-level, supportive framing).

### Composite Scores (0–100, weighted, explainable)
- **Sprint Health** — commitment reliability, scope stability, blocked time, flow.
- **Repository Health** — activity, churn, review coverage, hygiene, ownership.
- **Engineering Health (org)** — roll-up of flow + quality + reliability + people.
- **Risk Score** — aggregate of open risk findings × severity × recency.
- **Quality Score** — coverage, defect density, gates, debt.
- **Review Score** — coverage, depth, latency, distribution.
- **Release Confidence Score** — change risk, coverage of changes, open vulns, recent stability.
- **Innovation Score** — share of new-capability work vs maintenance/debt (investment mix).
- **Productivity Score** — flow-efficiency-weighted throughput (explicitly *not* LOC); team-level.
- **Predictability Score** — forecast accuracy + commitment reliability.
- **Collaboration/Network Score** — review/collaboration network balance.

> **Metric ethics rule:** Individual-level metrics are diagnostic aids for the individual and their manager's *support*, never ranking or performance scoring. Default presentation is team/aggregate. This is enforced in BC-2 (RBAC) and BC-13 (presentation).

---

## 9. Dashboard Design

Common to all: tenant/org/team/project/sprint/date-range/repo filters; saved views; drill-down to evidence; export (PDF/CSV); "Ask SprintIQ" assistant panel (Knowledge Agent); risk feed; scheduled email digest.

### 9.1 Developer Dashboard
- **KPIs:** My open PRs, PRs awaiting my review, my review wait time, my WIP, my cycle time.
- **Widgets:** My work board (linked stories↔PRs), blockers, "next best action" (Developer Agent), my PR aging.
- **Charts:** Personal cycle-time trend, review-latency trend.
- **Drill-downs:** PR → commits → linked story → quality on the change.
- **Filters:** Repo, sprint, date.
- **Actions:** Open PR/story, request review, escalate blocker, ask agent.

### 9.2 Team Lead / Scrum Master Dashboard
- **KPIs:** Sprint Health, commitment vs completion, scope creep, blocked items, at-risk stories.
- **Widgets:** Sprint burndown/burnup, at-risk story list (Scrum Master Agent), blocker board, WIP/aging, standup digest.
- **Charts:** Velocity trend, flow efficiency, cumulative flow diagram.
- **Drill-downs:** Story → status history → linked PRs/commits.
- **Filters:** Team, sprint, member, status.
- **Actions:** Generate standup/retro notes, flag risk, rebalance, notify (native delivery).

### 9.3 Engineering Manager Dashboard
- **KPIs:** Team Engineering Health, cycle time, review latency, throughput, capacity utilization, top risks.
- **Widgets:** Bottleneck diagnosis (EM Agent), workload balance, review network, dependency/cross-team risks, recommendation center.
- **Charts:** Cycle-time breakdown by stage, DORA-lite trends, WIP over time.
- **Drill-downs:** Stage → contributing items/PRs; member → workload (supportive).
- **Filters:** Team(s), repo, project, time.
- **Actions:** Accept/assign recommendations, message team, set goals/thresholds.

### 9.4 Product Owner Dashboard
- **KPIs:** Epic progress, predicted delivery dates, scope stability, predictability score.
- **Widgets:** Epic burnup, roadmap forecast, scope-change log, delivery-risk feed.
- **Charts:** Epic progress over time, forecast cone (confidence interval).
- **Drill-downs:** Epic → stories → status → linked code.
- **Filters:** Product, epic, release, team.
- **Actions:** Re-prioritize view, export forecast, ask "will epic X land by date Y?".

### 9.5 CTO Dashboard
- **KPIs:** Org Engineering Health, Risk Score, DORA (all four), Quality Score, Investment mix, Release Confidence.
- **Widgets:** Portfolio progress, risk landscape (heatmap), team comparison, hotspots/debt trend, security posture, exec narrative (Executive Agent).
- **Charts:** Org trend lines, DORA quadrant, investment distribution, debt trajectory.
- **Drill-downs:** Org → team → repo → finding.
- **Filters:** Org, division, team, time horizon.
- **Actions:** Drill to any team, export board pack, top-3 risks & actions.

### 9.6 CEO / Executive Stakeholder Dashboard
- **KPIs:** Are-we-on-track indicator, delivery confidence, top business risks, engineering investment vs plan.
- **Widgets:** Plain-language executive brief, traffic-light portfolio status, top-3 risks with owners.
- **Charts:** Delivery confidence trend, milestone status, investment mix.
- **Drill-downs:** Minimal — one level into "why" with agent explanation.
- **Filters:** Portfolio, quarter.
- **Actions:** Read/share brief, schedule digest.

### 9.7 Admin / Platform Dashboard
- **KPIs:** Integration health, ingestion lag, linkage coverage, AI cost/usage, active users.
- **Widgets:** Connection status (BC-0), event throughput/DLQ, correlation coverage & orphans, RBAC overview, audit search.
- **Charts:** Ingestion lag trend, cost trend, error rates.
- **Actions:** Manage connections/keys, manage users/roles, replay events, set budgets.

---

## 10. Rule Engine

### 10.1 Concept

A **configurable, explainable, tenant-overridable** engine that evaluates conditions over metrics, the delivery graph, and events, and emits standardized findings. Rules are data, not code — shipped as a library of defaults, customizable per tenant.

### 10.2 Rule anatomy

```
Rule:
  id, name, family, description
  scope:        tenant | org | team | repo | project | developer | sprint
  trigger:      event-driven | scheduled-sweep | metric-threshold-cross
  condition:    expression over metrics/graph (thresholds, windows, trends, percentiles)
  severity:     info | low | medium | high | critical (can be dynamic from magnitude)
  evidence:     which metrics/entities support the finding (for explainability)
  recommendation: templated, agent-enrichable guidance
  owner:        role/persona responsible to act
  suppression:  debounce, quiet windows, dedupe key
  escalation:   severity ramp if unaddressed over time
  enabled / overridden-thresholds (per tenant)
```

**Every fired rule produces a Finding:** `Risk + Severity + Evidence + Recommendation + Owner` — feeding BC-9 → BC-14 (decision loop) → BC-15 (notify) → dashboards.

### 10.3 Rule families & representative rules

**Delivery Risks**
- Sprint commitment probability < 70% with N days left → *high*, owner Scrum Master.
- Scope creep > 20% mid-sprint → *medium*.
- Story blocked > 2 days / aging beyond threshold → *medium*.
- Epic projected to miss target date → *high*, owner PO.

**Code Risks**
- PR size > X LOC / touches > Y files → *medium* (hard to review).
- Change touches a top hotspot with low coverage → *high*.
- High churn/rework on recently merged code → *medium*.

**Review Risks**
- PR open without review > 24/48h → *medium*, owner Team Lead.
- Large diff approved with zero comments (rubber-stamp) → *high*.
- Self-merge on protected/high-risk repo → *high*.
- Single reviewer handling > X% of team's reviews → *medium* (bottleneck/bus-factor).

**Quality Risks**
- Coverage dropping N% over M sprints → *medium*.
- Quality gate failing on main → *high*.
- Defect density rising vs baseline → *medium*.

**Release Risks**
- Release confidence < threshold → *high*, owner Release.
- Open critical vulnerability in release scope → *critical*, owner Security.
- Change-failure-rate trending up → *high*.

**Developer Risks** *(supportive, team-level by default)*
- Sustained over-WIP / after-hours pattern → *medium* burnout signal, owner EM.
- New joiner with no merged PR after N weeks → *low* onboarding support.

**Capacity Risks**
- Team committed > historical capacity → *high* over-commitment.
- Severe workload imbalance across team → *medium*.
- Key dependency owner overloaded → *high*.

**Architecture Risks**
- Bus-factor = 1 on critical module → *high*, owner Architect/EM.
- Technical-debt ratio trending up beyond threshold → *medium*.
- High coupling/dependency-risk cluster → *medium*.

### 10.4 Lifecycle
`Evaluate → Fire (dedupe/debounce) → Enrich (agent adds context/explanation) → Route (owner) → Decision (accept/dismiss/snooze) → Outcome (measured) → Learn (feeds memory & rule tuning)`.

---

## 11. Integration Architecture

### 11.1 Principle: native collectors are the only door; one ingestion pipeline is the brain

```
┌──────────────┐  webhooks (push)  ┌─────────────────────────────────────────────┐
│ Jira / GitHub │──────────────────►│ BC-1 Collectors & Ingestion (NestJS)        │
│ GitLab / ADO  │                   │  per source: client + webhook receiver +    │
│ Sonar/Jenkins │◄──────────────────│             scheduled poller                │
│ Slack/Teams   │  poll / API (pull)│  pipeline: verify sig → idempotency →       │
│ (notify out)  │◄──────────────────│   raw store → normalize → domain event      │
└──────────────┘  native delivery   └────────────────────┬────────────────────────┘
        ▲                                                 │ canonical domain events
        └──────── all source I/O lives in BC-1 ───────────┘ → internal event bus
```

**Hard boundaries:**
- **Collectors (BC-1) are the only code that talks to source systems** — inbound webhooks *and* outbound polling/API calls. No other context calls a source API or receives its webhooks.
- Each source is an **isolated collector**: typed API client (OAuth/app-install/PAT + token refresh), webhook receiver (per-provider signature verification), and scheduled poller (pagination, rate-limit backoff, incremental-sync cursors, backfill).
- **One internal ingestion pipeline** for every event (push or pull): verify → idempotency → raw-event store → normalize → canonical domain event. No source-specific writes scattered across domain tables.
- SprintIQ owns validation, business rules, metrics, AI, dashboards, analytics, persistence — end to end, in tested, version-controlled code.

### 11.2 Inbound integration patterns
- **Webhook-driven (primary):** real-time events (Jira issue updated, PR opened, build finished) hit a public per-source receiver (`/webhooks/{source}`), signature-verified, then enter the pipeline.
- **Scheduled polling / reconciliation (secondary):** NestJS Scheduler jobs pull snapshots/backfills (full sprint state, repo list) to heal missed webhooks and cover sources with weak/no webhooks; pollers and webhooks converge idempotently.
- **Idempotency:** every event carries a deterministic source + idempotency key; BC-1 de-dupes so push and pull never double-count.
- **Source-typed normalization:** raw payloads normalize into a stable canonical contract grouped by domain (planning, code, ci, quality), independent of source-tool quirks.

### 11.3 Outbound integration patterns
- SprintIQ (BC-15) delivers notifications **natively** to Slack/Teams/email via provider clients/incoming-webhooks, with templating, routing, throttling, and quiet hours resolved in SprintIQ.
- Human-approved agent actions (e.g., post sprint summary, open a Jira ticket) use the Collector context's outbound source clients — the same governed, audited path.

### 11.4 Multi-instance / multi-tenant integration
- Multiple Jira instances, multiple GitHub orgs per tenant — each is a registered connection (BC-0) with its own credentials and namespace.
- Every ingested event is tagged with `tenant_id`, `connection_id`, `source_system`; correlation (BC-5) resolves entities within the correct tenant boundary.

---

## 12. Event Flow

### 12.1 End-to-end ingestion → insight

```
1. Source fires webhook (e.g., GitHub "PR merged") OR poller fetches it on schedule
        │
2. BC-1 collector receives it on /webhooks/github (or via the GitHub poller)
        │
3. BC-1 Ingestion: verify provider signature → validate schema → idempotency check
        │  ├─ persist RAW event (replayable, audit)
        │  └─ normalize → canonical DomainEvent  (e.g., PullRequestMerged)
        │
4. DomainEvent published on internal event bus (tenant-scoped)
        │
5. Domain context consumes & persists facts:
        ├─ BC-4 Code: PR/commit/diff facts
        ├─ BC-3 Planning / BC-6 CI / BC-7 Quality (per source)
        │
6. BC-5 Correlation reacts: extract Jira keys → link Repo→PR→Commit→Story→Epic
        │  └─ updates the Delivery Graph (+confidence, +orphan flags)
        │
7. BC-8 Metrics recompute affected metrics (incremental) + scheduled rollups
        │
8. BC-9 Rule Engine evaluates affected rules → emits Risk Findings
        │
9. BC-11 Agents (event- or schedule-triggered) enrich findings / generate narratives
        │     using BC-12 memory + read tools over BC-5/8/10
        │
10. Outputs fan out:
        ├─ BC-13 Dashboards (read models updated)
        ├─ BC-14 Recommendations (lifecycle entry)
        └─ BC-15 Notifications → native delivery → Slack/Teams/email
        │
11. BC-16 Audit & lineage record the whole chain (event → metric → risk → action)
```

### 12.2 Processing modes
- **Real-time (event-driven):** steps 3–8 on each collected webhook event for low-latency facts & risk.
- **Scheduled (NestJS Scheduler, M17):** periodic rollups, full rule sweeps, agent digests (daily standup, weekly EM brief, exec summary), reconciliation pulls, forecast recompute.
- **On-demand:** user asks the Knowledge Agent → live tool reads over current graph/metrics.

### 12.3 Reliability semantics
- At-least-once delivery (webhooks + pollers) → idempotent ingestion → effectively-once persistence.
- Raw-event store enables **replay** (recompute graph/metrics after logic changes).
- Dead-letter queue + alerting on validation/processing failures (BC-0/16).
- Full data lineage so any number on a dashboard traces back to source events.

---

## 13. Future Expansion

- **More sources:** Bitbucket, Linear, Asana, PagerDuty/Opsgenie (incidents → real CFR/MTTR), Datadog/Sentry (runtime quality), Snyk/Dependabot (deeper security), Figma/PRD tools (idea-to-delivery).
- **Cross-tenant benchmarking** (opt-in, anonymized): percentile your DORA/flow vs industry cohort.
- **What-if & capacity simulation:** "if we add 2 engineers / cut scope 20%, when does epic X land?"
- **Deeper ML:** change-risk prediction, defect-escape prediction, attrition/burnout early-warning, forecast calibration, anomaly detection.
- **Autonomous agent workflows** (with approval): auto-draft retros, auto-open risk tickets in Jira (via the Collector's outbound client), auto-rebalance review assignments.
- **Developer Experience (DX) surveys** blended with system metrics (DX/SPACE framework).
- **Cost intelligence:** map engineering effort & cloud cost to features/epics (FinOps for eng).
- **Mobile app & Slack/Teams-native experiences** for briefings.
- **Marketplace:** shareable rule packs, metric definitions, dashboard templates.
- **Public/embeddable API & SDK** for customers to build on the delivery graph.

---

## 14. Recommended Development Phases

> Build the moat first (correlation + trustworthy metrics), then intelligence, then breadth.

### Phase 0 — Foundations (weeks 0–4)
- Multi-tenant skeleton, Identity/RBAC/JWT/SSO (BC-2), config, CI/CD, observability baseline.
- Collector framework + ingestion pipeline (BC-1): shared client/poller/webhook primitives + raw-event store + idempotency + canonical envelope.
- Source-system registry (BC-0) with credential/secret + webhook-secret management.
- **Exit:** first native collector (webhook + poller) ingests end-to-end for one source.

### Phase 1 — Core Graph & Metrics MVP (weeks 4–12)
- Native Jira + GitHub collectors (webhook + poller) feeding Planning (BC-3) + Code (BC-4) contexts.
- **Correlation Engine + Delivery Graph (BC-5)** — the centerpiece.
- Metrics Engine v1 (flow, throughput, PR/review, DORA-lite) (BC-8).
- Dashboards: Developer, Scrum Master, EM (BC-13).
- Knowledge Agent (ask-your-data) + Agent Runtime (BC-11/12).
- **Exit:** a real team sees trusted, correlated metrics and can query them in NL.

### Phase 2 — Risk & Proactive Intelligence (weeks 12–22)
- Rule & Risk Engine (BC-9) + Recommendation/Decision loop (BC-14).
- Scrum Master & EM agents (proactive) + native Notifications (BC-15).
- Analytics v1: hotspots, ownership, knowledge concentration, review network (BC-10).
- Quality & Security + CI/CD contexts (BC-6/7); Release/QA/Security/Code/Review agents.
- **Exit:** platform proactively surfaces risk + recommendations across delivery.

### Phase 3 — Breadth & Prediction (weeks 22–34)
- GitLab + Azure DevOps + SonarQube + Jenkins/Actions full coverage.
- Predictive delivery, release confidence, debt trends; Architecture & Executive agents.
- CTO/CEO/PO dashboards; scheduled exec digests.
- **Exit:** multi-source, predictive, executive-ready.

### Phase 4 — Scale, Learn & Extend (weeks 34+)
- Cross-tenant benchmarking (opt-in), custom metrics/rules builder, what-if simulation.
- Decision-loop learning (recommendation effectiveness → agent tuning).
- Performance hardening for thousands of devs / hundreds of repos.
- **Exit:** enterprise scale + self-improving intelligence.

---

## 15. Suggested Microservice Boundaries

### 15.1 Stance: **modular monolith first, extract by pressure**

For NestJS + PostgreSQL at the stated scale, start as a **modular monolith** (clear module boundaries = bounded contexts, single deployable) and extract services only where scaling/isolation pressure demands. Premature microservices add distributed-systems cost without payback at MVP.

### 15.2 Target service decomposition (when you split)

| Service | Bounded contexts | Why it's a boundary | Scaling driver |
|---|---|---|---|
| **collector-service** | BC-1, BC-0 | Spiky webhook + scheduled-poll load; security isolation; must stay up independently | Webhook bursts / poll fan-out |
| **identity-service** | BC-2 | Security/compliance isolation; stable | Low/steady |
| **planning-service** | BC-3 | Jira domain | Moderate |
| **code-service** | BC-4 | Git domain; highest event volume | High (commits/PRs) |
| **delivery-cicd-service** | BC-6 | CI domain | Moderate |
| **quality-security-service** | BC-7 | Scan domain | Moderate |
| **correlation-service** | BC-5 | CPU-heavy graph building; core IP; independent scaling | High |
| **metrics-service** | BC-8 | Compute-heavy aggregation | High |
| **rules-risk-service** | BC-9 | Frequent evaluation sweeps | Moderate |
| **analytics-service** | BC-10 | Heavy/batch graph analytics | Bursty/batch |
| **ai-agent-service** | BC-11, BC-12 | Different runtime profile (LLM I/O, cost, GPU/vector); strong isolation for cost & guardrails | Variable, costly |
| **recommendation-service** | BC-14 | Lifecycle state | Low |
| **dashboard-bff** | BC-13 | Read-optimized API for frontend | Read-heavy |
| **notification-service** | BC-15 | Native outbound delivery; throttling | Bursty |
| **scheduler** | M17 | Cron/jobs orchestration | Steady |
| **(cross-cutting)** | BC-16 | Audit/observability as a shared library + sink | — |

### 15.3 Communication & data
- **Sync (REST/gRPC):** ingestion → dashboard-bff reads; agent tool calls.
- **Async (event bus):** domain events drive correlation → metrics → rules → agents → notifications. (Redis Streams/optional Kafka later; in monolith, an in-process event bus.)
- **Data ownership:** each service owns its tables; no cross-service DB reads. The delivery graph is owned by correlation-service and read by others via API/read-models. Shared PostgreSQL, single schema with table-prefix context boundaries + no cross-context FKs in the monolith (ADR-0005); separate DBs on extraction.
- **Tenancy:** `tenant_id` on every record/event/request; enforced centrally.

---

## 16. Risks

| # | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | **Correlation accuracy** (Jira keys missing/wrong in branches/PRs/commits) undermines trust | High | High | Multi-strategy extraction (regex+heuristics+ML), confidence scores, orphan surfacing, manual-link UI, conventions guidance |
| R2 | **Garbage-in metrics** from inconsistent tool usage across teams | High | High | Data-quality scoring, transparency on coverage, "metric health" indicators, configurable definitions |
| R3 | **AI hallucination / wrong numbers** erode credibility | High | Med | Tool-grounded numbers only, citation enforcement, guardrails, eval harness, human-in-loop |
| R4 | **Metrics weaponized** for individual ranking → gaming, morale damage | High | Med | Team-level defaults, RBAC limits, ethics policy, anti-vanity metric design |
| R5 | **Ingestion overload / missed webhooks** at scale | Med | Med | Idempotent at-least-once, DLQ, reconciliation pulls, raw-event replay |
| R6 | **Collector maintenance burden** (owning connectors against Jira/GitHub/GitLab/ADO/Sonar/Jenkins API churn) | Med | High | Shared collector framework, canonical envelope isolating quirks, per-collector contract tests, phase sources by value |
| R7 | **Multi-tenant data leakage** | Critical | Low | Tenant-scoped everything, isolation tests, least-privilege, audit |
| R8 | **AI cost runaway** | Med | Med | Per-tenant budgets, model tiering, caching, batch where possible |
| R9 | **Over-engineering (premature microservices)** slows MVP | Med | Med | Modular monolith first; extract by measured pressure |
| R10 | **Prompt injection** via ingested PR/commit text | Med | Med | Treat ingested text as untrusted, sandboxed prompts, output validation |
| R11 | **Vendor/API drift** (Jira/GitHub API changes) | Med | Med | Source quirks isolated at the collector edge by the canonical envelope; per-collector contract tests against fixtures |
| R12 | **Compliance/data-residency** for enterprise | High | Med | Regional deployment, data-handling controls, SOC2 roadmap, configurable retention |
| R13 | **Public webhook endpoints + source-secret custody** (attack surface; OAuth/app tokens to protect) | High | Med | Per-provider signature verification, replay/timestamp guards, rate-limit/abuse controls, secrets via vault/KMS by reference, never logged |
| R14 | **Collector boundary erosion** (a domain context calls a source API directly) | Med | Low | Architectural guardrail (BC-1 is the only door), import/architecture tests, code review |

---

## 17. Assumptions

1. **SprintIQ owns its collectors** — native NestJS webhook receivers + scheduled pollers per source — and accepts the connector-maintenance burden that comes with it.
2. Source tools (Jira, GitHub, etc.) expose webhooks + APIs the collectors can consume, with credentials provisionable per tenant (OAuth app / GitHub App install / PAT).
3. Developers (mostly) reference Jira keys in branches/PRs/commits — and where they don't, SprintIQ degrades gracefully and surfaces orphans.
4. PostgreSQL (with extensions, e.g., `pgvector` for embeddings) suffices for early scale; Redis optional for cache/queues.
5. SprintIQ is **insight, not system-of-record** — it never becomes the source of truth for tickets/code.
6. Customers accept SaaS multi-tenancy (with a path to single-tenant/regional for enterprise).
7. LLM access (Claude / hosted models) is available with per-tenant cost governance.
8. Initial scale targets: thousands of devs, hundreds of repos, multiple orgs/projects/Jira instances, multiple concurrent sprints.
9. Metrics are used ethically (team improvement, not individual punishment) — enforced by product design.
10. Frontend is React + Tailwind consuming the dashboard BFF; auth via JWT/RBAC/SSO.

---

## 18. Product Differentiators

1. **The Delivery Graph (the moat):** automatic, confidence-scored Repo→PR→Commit→Story→Epic→Project correlation across many tools and tenants — most competitors silo by tool.
2. **Agents, not just dashboards:** role-specific AI advisors that proactively reason, explain causality, and recommend — versus passive charts.
3. **Explainable & grounded AI:** every score/risk/recommendation cites its evidence; numbers come from the metrics engine, not the LLM.
4. **Decision feedback loop:** recommendations are tracked to outcomes; the platform measurably learns what advice works.
5. **Breadth of intelligence:** planning → code → review → quality → security → build → release → ops in one correlated model.
6. **Configurable rule & metric engine:** organizations encode their own judgment; not a fixed opinion.
7. **Ethics-first metrics:** anti-vanity, team-level-by-default, designed against misuse — a trust differentiator for enterprises.
8. **Owned native collectors:** first-party integration layer (like LinearB/Jellyfish) — full control over correctness, backfill, rate limits, and self-serve onboarding; source quirks isolated behind a canonical contract.
9. **Ask-your-data:** natural-language querying over the entire delivery graph for every persona.

---

## 19. Commercial Positioning

### 19.1 Category
**Engineering Intelligence Platform** — at the intersection of LinearB (workflow/flow metrics), Jellyfish (business alignment), DX (developer experience), and GitHub Insights (repo analytics), **differentiated by built-in AI agents and a cross-tool delivery graph**.

### 19.2 Positioning statement
> *For engineering leaders who are drowning in tools but starved for insight, SprintIQ is the AI-powered Engineering Intelligence Platform that continuously correlates delivery data across the whole SDLC and gives every role — from developer to CEO — an AI advisor that explains what's happening, what's at risk, and what to do next. Unlike dashboard-only tools, SprintIQ reasons, recommends, and learns.*

### 19.3 Buyers & users
- **Economic buyer:** CTO / VP Engineering (and CFO for FinOps angle).
- **Champion:** Engineering Managers, Heads of Delivery, Platform/DevEx leads.
- **Daily users:** Developers, Scrum Masters, EMs, POs.

### 19.4 Pricing model (directional)
- **Per-developer/month** tiered (Team / Business / Enterprise), aligned to seats analyzed.
- **AI usage** included by tier with overage governance (transparent token budgets).
- **Enterprise:** SSO, single-tenant/regional, advanced security, custom rules, benchmarking, SLA.
- **Land-and-expand:** start with one team's metrics → expand to org-wide intelligence + AI agents.

### 19.5 Value narrative (ROI)
- Less time building reports; faster cycle time; lower change-failure rate; earlier risk detection; better predictability → fewer missed commitments; reduced bus-factor/attrition risk. Tie to dollars via FinOps/effort-allocation later.

### 19.6 Competitive framing
| | Dashboards (GitHub Insights) | Flow tools (LinearB) | Business-alignment (Jellyfish) | DX (DX/SPACE) | **SprintIQ** |
|---|---|---|---|---|---|
| Cross-tool delivery graph | Partial | Partial | Partial | No | **Yes (moat)** |
| Built-in AI agents | No | Emerging | Emerging | No | **Yes (core)** |
| Explainable recommendations + outcome loop | No | Partial | Partial | Survey-based | **Yes** |
| Whole-SDLC (plan→ops) breadth | Partial | Partial | Yes | Partial | **Yes** |
| Ethics-first metrics | — | Partial | Partial | Yes | **Yes** |

---

## 20. Final Architecture Recommendation

### 20.1 The recommendation in one paragraph
Build SprintIQ as a **multi-tenant, event-driven modular monolith on NestJS + PostgreSQL**, organized strictly around the **17 bounded contexts** above, with the **Correlation & Delivery Graph (BC-5)** and the **AI Agent Runtime (BC-11)** as the deliberate centers of gravity. Own the integration layer with **native collectors (BC-1) as the only door to the outside world** — per-source webhook receivers + scheduled pollers feeding one idempotent, lineage-preserving ingestion pipeline; no other context touches a source API. Make **metrics grounded and AI explainable**, ship **ethics-first** metric design, and **close the loop** from insight to recommendation to measured outcome. Extract microservices later, by measured pressure, starting with the collector service, correlation, metrics, and the AI agent service.

### 20.2 Sequenced priorities
1. **Win trust first:** correlation accuracy + trustworthy metrics + transparency (Phases 0–1). Nothing else matters if the numbers aren't believed.
2. **Then make it proactive:** rules, risks, recommendations, and the first agents (Phase 2).
3. **Then go broad and predictive:** all sources, predictive analytics, executive intelligence (Phase 3).
4. **Then scale and learn:** benchmarking, customization, decision-loop learning (Phase 4).

### 20.3 Non-negotiable architectural guardrails
- External systems are reached **only** through the Collector context (BC-1); all data flows through one pipeline with signature verification + idempotency + validation. No other context calls a source API.
- Every record/event/query is **tenant-scoped**; isolation is tested, not assumed.
- AI is **tool-grounded and cited**; LLMs never originate metrics.
- Metrics are **team-level by default**, anti-vanity, and RBAC-bounded against misuse.
- Every dashboard number is **traceable to source events** (full lineage).
- **Modular monolith first**; clean context boundaries make later extraction cheap.

### 20.4 What makes this win
The defensibility is the **delivery graph × AI agents × decision loop**. Competitors can copy a chart; copying a correlated, multi-tenant delivery graph that feeds explainable, learning AI advisors per role is hard. Build that core exceptionally well, own a clean native-collector integration boundary, and SprintIQ becomes the engineering decision system of record — the layer leaders open first every morning.

---

*End of master architecture document. Detailed data models, API contracts, and ADRs are derived from this baseline and live under `docs/architecture/`, `docs/api/`, and `docs/ADR/`.*
