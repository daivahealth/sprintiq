# AI Agent Specification

Authoritative spec for SprintIQ's AI agents (BC-11 runtime + BC-12 memory): the shared runtime, the tool contract, guardrails, and the per-agent definitions (responsibilities, inputs/outputs, prompts, memory, decision-making).

> Context: [PRODUCT-ARCHITECTURE.md §5](../architecture/PRODUCT-ARCHITECTURE.md), [DATA-MODEL.md §12](../architecture/DATA-MODEL.md) (`embedding`, `agent_memory`, `agent_run`), [security/AUTH-AND-RBAC.md §6](../security/AUTH-AND-RBAC.md) (agent governance). Filename is `AI-AGENTS.md` (not `AGENTS.md`) to avoid colliding with the agent-operating-contract convention.

---

## 1. Principles (apply to every agent)

1. **Read-mostly advisors.** Agents reason and recommend. They mutate SprintIQ state only via governed actions (e.g., create a recommendation) and external systems only via the Collector context's outbound clients with **human approval**.
2. **Tool-grounded, never inventing numbers.** Every quantitative claim comes from a tool read into the Metrics Engine / delivery graph. LLMs do not originate metrics.
3. **Cited.** Every claim links to evidence (a metric value, PR, finding). Output includes citations.
4. **Tenant-isolated.** Retrieval, memory, and tool reads are scoped to one tenant. No cross-tenant context, ever.
5. **Governed.** Per-tenant model tier + token budget; PII redaction; prompt-injection defense on ingested text; every run audited (`agent_run`).
6. **Ethics-bound.** Agents present team-level metrics by default and never produce individual rankings or surveillance output.

---

## 2. Shared Agent Runtime

```
trigger (user msg | schedule | rule_finding)
   │
   ▼
[1] Router/Orchestrator  → classify intent, select persona agent(s) + scope (tenant/role/team)
[2] Context assembly      → RAG retrieve (BC-12, tenant-partitioned) + structured tool reads
[3] Reason loop           → LLM with tool-calling; iterate read → reason → read
[4] Guardrails            → grounding/citation check · PII redaction · injection filter · cost/limit
[5] Output                → narrative + citations + (optional) proposed actions
[6] Persist               → agent_run (audit/cost) + memory write (episodic/decision)
```

- **Model:** latest capable Claude model by default; per-tenant provider/model/budget overrides are read from `tenant_configuration` namespace `llm`, with API keys referenced by secret ref only.
- **Determinism:** numeric content is deterministic (from tools); the LLM composes explanation/narrative around it.
- **Failure mode:** if grounding/evidence is insufficient, the agent **says so and declines** rather than guessing (no hallucinated metrics).

---

## 3. Tool contract

Agents act only through these tools. **Read tools** are unrestricted (within tenant + RBAC scope); **action tools** require human-in-the-loop approval and are audited.

### Read tools
| Tool | Purpose |
|---|---|
| `query_delivery_graph(query)` | Traverse Repo→PR→Commit→Story→Epic; resolve links + confidence. |
| `get_metric(key, scope, period)` | Fetch metric_value(s) with metric_health. |
| `get_composite_score(key, scope, period)` | Fetch a score + its components (the "why"). |
| `list_risks(scope, filters)` | Open `rule_finding`s with evidence. |
| `get_sprint_health(sprint_id)` / `get_repo_health(repo_id)` | Pre-built health bundles. |
| `get_story(key)` / `get_pr(id)` | Entity detail + linked context. |
| `forecast_delivery(target)` | Prediction + confidence band (BC-10). |
| `search_knowledge(query)` | RAG over graph/metrics/docs (BC-12). |

### Action tools (governed)
| Tool | Effect | Gate |
|---|---|---|
| `create_recommendation(...)` | Create a `recommendation` (BC-14). | Logged; user-visible; reversible. |
| `request_notification(...)` | Native delivery to Slack/Teams/email (BC-15). | **Human approval** + audit. |
| `propose_external_action(...)` | e.g., draft Jira comment/ticket via the Collector's outbound client. | **Human approval** + audit (roadmap). |

> Tool inputs/outputs are tenant-scoped server-side; an agent cannot widen its scope by crafting arguments.

---

## 4. Memory model (BC-12)

Per `(tenant, agent)`:
- **Episodic** — past conversations/analyses (recency-weighted).
- **Semantic** — embeddings of graph/metrics/docs for RAG.
- **Decision** — recommendations made → outcomes measured (the learning signal; links to `recommendation.outcome`).
- **Working** — current-session scratch.

Memory is tenant-partitioned and never shared across tenants. Decision memory is what lets agents improve advice over time (which recommendations actually worked).

---

## 5. Guardrails (enforced in runtime, step 4)

- **Grounding/citation:** numeric claims must map to a tool result; un-cited numbers are stripped/blocked.
- **Prompt-injection:** ingested text (PR/commit/comment bodies) is treated as untrusted data, never as instructions; tool outputs validated.
- **PII & confidentiality:** redaction; developer-private metrics stay private; RBAC scope honored.
- **Cost/rate:** per-tenant token budget + model tier; throttle/queue on overage.
- **Human-in-the-loop:** action tools never auto-execute outbound/state-changing effects.
- **Audit:** `agent_run` records trigger, inputs ref, tools called, output ref, tokens, cost.

---

## 6. Agent registry

| Agent | Persona served | Primary trigger | Lead outputs |
|---|---|---|---|
| A0 Orchestrator | (internal) | every request | routing, multi-agent synthesis |
| A1 Scrum Master | Scrum Master, team | schedule + on-demand | sprint health, standup/retro, forecast |
| A2 Engineering Manager | EM, team lead | schedule + on-demand | team health, bottlenecks, interventions |
| A3 Developer | Developer | on-demand | personal next-best-action |
| A4 Architecture | Architect, EM | schedule + on-demand | debt/hotspot/refactor ROI |
| A5 Repository Intelligence | EM, architect | schedule | repo health |
| A6 Code Intelligence | Developer, reviewer | event (PR) + on-demand | PR change-risk explanation |
| A7 Review | Team lead, EM | schedule + event | review bottlenecks, stale PRs |
| A8 QA / Quality | QA, EM | schedule | quality posture & risks |
| A9 Release | Release mgr, EM | event (release) + on-demand | release confidence, go/no-go |
| A10 Security | Security, EM | schedule + event | vulnerability priorities |
| A11 Executive | CTO, CEO, exec | schedule + on-demand | org briefing, top-3 risks |
| A12 Knowledge | all personas | on-demand (chat) | cited NL answers ("ask your data") |

---

## 7. Per-agent specifications

For each: **Responsibilities · Inputs/Tools · Outputs · Interactions · System-prompt focus · Memory · Decision logic.**

### A0 — Orchestrator (internal)
- **Responsibilities:** intent classification, agent selection, multi-agent composition, dedupe overlapping findings, enforce global budget/guardrails.
- **Tools:** routing metadata; invokes other agents.
- **Output:** unified, de-conflicted response.
- **Prompt focus:** *"Route this request to the right agent(s) for the user's role and scope; synthesize their grounded outputs into one answer without duplication."*
- **Decision logic:** intent → agent set → (parallel reads) → synthesize → guardrail.

### A1 — Scrum Master Agent
- **Responsibilities:** sprint health, scope-creep, blockers, at-risk/stale stories, standup & retro inputs, completion forecast.
- **Inputs/Tools:** `get_sprint_health`, `get_metric(velocity|flow_efficiency|scope_creep)`, `list_risks(scope=sprint)`, `forecast_delivery(sprint)`.
- **Outputs:** daily sprint-health narrative, at-risk story list, predicted completion (range), retro talking points.
- **Interactions:** escalates to EM Agent; pulls blocker context from Developer Agent.
- **Prompt focus:** *"Given this sprint's scope, status history, velocity, and open risks, what threatens the sprint goal and what should the team do today? Cite the metrics. Forecast completion as a range with confidence."*
- **Memory:** per-team sprint patterns, recurring blockers, forecast-accuracy calibration.
- **Decision logic:** completion probability from historical throughput distribution vs remaining scope; flag when < threshold; rank blockers by blast radius.

### A2 — Engineering Manager Agent
- **Responsibilities:** team delivery health, bottleneck diagnosis, capacity/load balance, cross-team dependencies, burnout signals (team-level), 1:1 prep context.
- **Inputs/Tools:** `get_composite_score(engineering_health|review_score)`, `get_metric(cycle_time sub-phases|flow_efficiency|workload_balance)`, `list_risks(scope=team)`.
- **Outputs:** weekly team-health brief, bottleneck diagnosis, ranked interventions.
- **Interactions:** Scrum Master, Architecture, Executive agents.
- **Prompt focus:** *"Where is my team's flow constrained, who is overloaded (team-level, supportive), and what single change would most improve delivery? Ground every claim; rank interventions by expected impact."*
- **Memory:** team baselines, prior interventions + outcomes (decision memory).
- **Decision logic:** compare vs baseline/benchmark → attribute delta to the slowest flow stage → rank interventions by expected impact × confidence.

### A3 — Developer Agent
- **Responsibilities:** personal flow — my open PRs, PRs awaiting my review, my WIP/blockers, what to do next. **Self-help, not surveillance.**
- **Inputs/Tools:** `query_delivery_graph(my work)`, `get_pr`, `get_story`, `list_risks(scope=me)`.
- **Outputs:** prioritized personal to-do, blockers to escalate, focus suggestions.
- **Interactions:** Scrum Master, Code agents.
- **Prompt focus:** *"For this developer only, what is blocking their work and what is the highest-leverage next action? Private to them."*
- **Memory:** personal working patterns (private to the developer; RBAC-gated).
- **Decision logic:** prioritize by (blocks-others, age, sprint-goal criticality).

### A4 — Architecture Agent
- **Responsibilities:** structural health — coupling, hotspots, dependency risk, debt trajectory, bus-factor, refactor candidates.
- **Inputs/Tools:** `get_metric(code_churn|complexity|technical_debt_ratio)`, analytics reads (hotspots/ownership/dependency_risk), `list_risks(family=architecture)`.
- **Outputs:** architecture-risk report, refactor candidates ranked by risk×churn, debt-trend narrative.
- **Interactions:** EM, Code, Security agents.
- **Prompt focus:** *"Which parts of the codebase are decaying fastest and pose the most delivery/quality risk? Rank refactor ROI with evidence."*
- **Memory:** debt history, prior refactor outcomes.
- **Decision logic:** risk = f(churn, complexity, ownership concentration, defect density); ROI = risk reduction ÷ estimated effort proxy.

### A5 — Repository Intelligence Agent
- **Responsibilities:** per-repo health, activity, contributor distribution, branch hygiene, stale branches.
- **Inputs/Tools:** `get_repo_health`, `get_composite_score(repository_health)`, `query_delivery_graph(repo)`.
- **Outputs:** repo health score + narrative, hygiene issues.
- **Prompt focus:** *"How healthy is this repository and what is its biggest structural or process risk?"*
- **Memory:** repo baselines/trends.
- **Decision logic:** composite repo-health + anomaly detection on activity.

### A6 — Code Intelligence Agent
- **Responsibilities:** PR/commit-level change risk — "how risky is this change and why."
- **Inputs/Tools:** `get_pr`, `get_metric(pr_size|code_churn|coverage of change)`, hotspot overlap, linked story.
- **Outputs:** PR change-risk score + explanation; risky-change callouts.
- **Interactions:** Review, QA, Architecture agents; enriches `code.risky_change` findings.
- **Prompt focus:** *"Assess this change's risk from size, churn, hotspot overlap, ownership, and test-coverage delta. Explain why, cite the inputs."*
- **Memory:** historical change-risk vs realized defects (calibration).
- **Decision logic:** change-risk model over size/churn/hotspot/ownership/coverage; calibrated against escaped-defect history.

### A7 — Review Agent
- **Responsibilities:** review-process health — latency, reviewer load, rubber-stamping, coverage, network balance, stale PRs.
- **Inputs/Tools:** `get_composite_score(review_score)`, `get_metric(time_to_first_review|reviewer_load|review_depth)`, review-network analytics.
- **Outputs:** review-health insights, bottleneck reviewers, stale-PR alerts, reviewer-suggestion (lowest load).
- **Prompt focus:** *"Where is the review process slowing delivery or letting risk through? Suggest a balancing action."*
- **Memory:** review-latency baselines, reviewer-load patterns.
- **Decision logic:** outlier detection on latency/load; flag low-scrutiny merges on high-risk diffs.

### A8 — QA / Quality Agent
- **Responsibilities:** quality posture — coverage trend, defect density, escaped defects, gate breaches, test effectiveness.
- **Inputs/Tools:** `get_composite_score(quality_score)`, `get_metric(test_coverage|defect_density|escaped_defects|quality_gate_pass_rate)`, `list_risks(family=quality)`.
- **Outputs:** quality narrative, quality risks, coverage-gap callouts.
- **Prompt focus:** *"Is quality trending the right way, and where is risk leaking to production? Correlate coverage/gate breaches with escaped defects."*
- **Memory:** defect-density baselines, gate-breach history.
- **Decision logic:** correlate gate/coverage breaches with escaped defects; prioritize by impact.

### A9 — Release Agent
- **Responsibilities:** release readiness & confidence — DORA reliability, change-failure, deploy stability, go/no-go support.
- **Inputs/Tools:** `get_composite_score(release_confidence)`, `get_metric(change_failure_rate|build_success_rate|lead_time_for_changes)`, `list_risks(family=release)`, `query_delivery_graph(release scope)`.
- **Outputs:** **release confidence score + explanation**, blockers to release, post-release stability narrative.
- **Interactions:** QA, Security, Executive agents.
- **Prompt focus:** *"Given everything in this release — change risk, coverage of changed code, open vulns, recent failure rate, hotspot involvement — how confident should we be? List blockers."*
- **Memory:** past release outcomes vs predicted confidence (calibration).
- **Decision logic:** release_confidence composite; surface each component's contribution; recommend go/hold with evidence.

### A10 — Security Agent
- **Responsibilities:** vulnerability posture — unresolved CVEs, risky deps, security-gate status, exposure trend.
- **Inputs/Tools:** `get_metric(open_vulnerabilities|mttr_vuln|dependency_risk)`, `list_risks(family=release/security)`.
- **Outputs:** security-risk summary, prioritized vulnerabilities, exposure trend.
- **Prompt focus:** *"What is our most urgent security exposure and what should we fix first? Prioritize by severity × exploitability × reachability."*
- **Memory:** vulnerability lifecycle, mean-time-to-remediate.
- **Decision logic:** priority = severity × exploitability × reachability (hotspot/usage); flag critical in release scope.

### A11 — Executive Agent
- **Responsibilities:** org-wide synthesis for CTO/CEO — engineering health, portfolio/epic progress, investment mix, risk landscape, plain-language briefings.
- **Inputs/Tools:** `get_composite_score(engineering_health|risk_score|innovation_score|predictability_score)`, portfolio metrics, top `list_risks(scope=org)`.
- **Outputs:** executive narrative, board-ready summary, **top-3 risks + actions**.
- **Interactions:** synthesizes EM, Architecture, Release, Security agents (via Orchestrator).
- **Prompt focus:** *"In plain business language, how healthy is engineering, where is investment going, and what are the top 3 risks with owners? No jargon; cite the underlying scores."*
- **Memory:** org trend history, prior executive guidance.
- **Decision logic:** weighted aggregation of sub-scores; translate engineering signals to business framing; rank top risks by severity × scope.

### A12 — Knowledge Agent
- **Responsibilities:** natural-language Q&A over the delivery graph ("ask your data"), onboarding context, glossary; backs the chat surface for all personas; serves retrieval to other agents.
- **Inputs/Tools:** `search_knowledge`, `query_delivery_graph`, `get_metric`, all read tools.
- **Outputs:** cited answers, explanations, links to evidence.
- **Prompt focus:** *"Answer the user's question using only retrieved, cited platform data, within their RBAC scope. If evidence is insufficient, say so — never fabricate a number."*
- **Memory:** org glossary/ontology, frequent questions.
- **Decision logic:** retrieval-augmented; refuses/flags when evidence is insufficient; respects role scope.

---

## 8. Scheduled vs on-demand

- **Scheduled (Scheduler M17):** daily standup digest (A1), weekly EM brief (A2), weekly exec summary (A11), nightly architecture/quality/security sweeps (A4/A8/A10). Outputs route through BC-14/BC-15.
- **Event-triggered:** A6 on PR open/update (change-risk), A9 on release candidate, A7 on stale-PR threshold, finding-enrichment on rule fire.
- **On-demand:** A12 chat for any persona; any agent invokable from its dashboard.

---

## 9. Evaluation & quality

- **Grounding eval harness:** automated checks that numeric claims trace to tool results (no hallucinated metrics) — gate on regression.
- **Recommendation effectiveness:** decision memory tracks accepted recommendations → measured outcomes; agents are tuned toward advice that worked.
- **Calibration:** forecast/change-risk/release-confidence agents track predicted vs actual; calibration surfaced to admins.
- **Red-team:** prompt-injection and cross-tenant-leak test suites run against agents.

---

## 10. Change policy

Adding/changing an agent, tool, or guardrail updates this spec; new tools must be tenant-scoped + audited; new action tools require human-in-the-loop + ethics review; consumed metrics must exist in [METRICS.md](METRICS.md). Align with [security/AUTH-AND-RBAC.md](../security/AUTH-AND-RBAC.md).
