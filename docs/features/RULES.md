# Rule & Risk Pack Specification

Authoritative specification for the SprintIQ Rule & Risk Engine (BC-9): how rules are structured, evaluated, governed, and the default rule pack shipped to every tenant.

> Context: [PRODUCT-ARCHITECTURE.md §10](../architecture/PRODUCT-ARCHITECTURE.md), [DATA-MODEL.md §10](../architecture/DATA-MODEL.md) (`rule`, `rule_finding`, `recommendation`), [METRICS.md](METRICS.md) (rule inputs). Rules are **data, not code** — a default library customizable per tenant.

---

## 1. Rule model

Every rule conforms to this shape (stored in `rule`):

```jsonc
{
  "id": "review.stale_pr",
  "name": "Pull request awaiting review too long",
  "family": "review",                 // delivery|code|review|quality|release|developer|capacity|architecture
  "description": "PR open without a first review beyond the SLA.",
  "scope": "repo",                    // tenant|org|team|repo|project|developer|sprint
  "trigger": "scheduled",             // event | scheduled | threshold_cross
  "inputs": ["time_to_first_review", "pull_request.state"],
  "condition": "pr.state == 'open' && now - pr.opened_at > threshold('hours', 24)",
  "severity_policy": {                // static or magnitude-derived
    "type": "graduated",
    "bands": [{ "ge": 24, "sev": "medium" }, { "ge": 48, "sev": "high" }]
  },
  "evidence": ["pr.id", "time_to_first_review", "reviewer_load"],
  "recommendation_template": "PR {{pr.title}} has waited {{hours}}h for review. Suggest assigning {{suggested_reviewer}} (lowest current load).",
  "owner_role": "team_lead",
  "suppression": { "debounce_hours": 12, "dedupe_key": "repo:{{pr.id}}", "quiet_hours": true },
  "escalation": { "after_hours": 24, "raise_to": "high", "notify_role": "eng_manager" },
  "enabled": true,
  "tenant_overrides": { "thresholds": {}, "enabled": null, "severity": null }
}
```

### Field semantics
- **trigger:** `event` (evaluate on a relevant domain event), `scheduled` (rule sweep on cadence), `threshold_cross` (when a metric crosses a bound).
- **condition:** boolean expression over metrics (BC-8), graph (BC-5), and entity facts. Supports thresholds, rolling windows, trends/slopes, percentiles, and counts. References metrics by their catalog key.
- **severity_policy:** `static` or `graduated` (severity derived from magnitude). Severities: `info < low < medium < high < critical`.
- **evidence:** the metric values / entities attached to the finding for explainability and lineage.
- **owner_role:** the persona accountable to act (routes the finding + notification).
- **suppression:** `debounce` (don't re-fire within window), `dedupe_key` (one open finding per key), `quiet_hours` (respect tenant quiet hours for notification).
- **escalation:** auto-raise severity / re-route if unaddressed.
- **tenant_overrides:** thresholds, enable/disable, severity — per tenant, without forking the rule.

---

## 2. Finding lifecycle

```
evaluate ─► fire (apply dedupe/debounce) ─► enrich (agent adds context/explanation, BC-11)
        ─► route to owner_role ─► notify (BC-15 native delivery, if configured)
        ─► decision (BC-14: accept | dismiss | snooze | acted)
        ─► outcome measured ─► learn (feeds agent memory + rule tuning)
```

- A fired rule creates a `rule_finding` = **Risk + Severity + Evidence + Recommendation + Owner** (the standard contract).
- Findings are **idempotent per `dedupe_key`**: re-evaluation updates the existing open finding (severity, evidence, last_seen) rather than spamming new ones.
- Resolved-then-recurring conditions open a new finding (with reference to the prior).
- Every finding carries lineage to the metrics/events that triggered it.

---

## 3. Evaluation engine

- **Event-driven:** on each relevant domain event, only rules whose `inputs` intersect the change are evaluated (cheap, low-latency).
- **Scheduled sweeps:** the Scheduler (M17) runs full-family sweeps on cadence (e.g., delivery hourly during work hours, quality/security daily) to catch slow-moving / point-in-time conditions.
- **Tenant-scoped:** rules only ever see one tenant's data; defaults + tenant customizations are merged at load.
- **Safe expressions:** conditions run in a sandboxed evaluator over a typed context object — no arbitrary code, no DB access from the expression.
- **Backpressure-aware:** evaluation is async off the event bus; bursts queue rather than block ingestion.

---

## 4. Default rule pack

Severities shown are defaults; thresholds are tenant-overridable. Each maps to an `owner_role` and a recommendation.

### Delivery risks (owner: scrum_master / product_owner)
| id | Condition (summary) | Severity |
|---|---|---|
| `delivery.sprint_goal_at_risk` | sprint commitment probability < 70% with ≥1 day left | high |
| `delivery.scope_creep` | scope_creep > 20% mid-sprint | medium |
| `delivery.story_blocked` | story blocked_time > 2 days | medium |
| `delivery.story_aging` | in-progress story age > threshold for status | medium |
| `delivery.epic_off_track` | epic predicted_delivery_date > target_date | high (PO) |
| `delivery.low_flow_efficiency` | team flow_efficiency < 40% (rolling) | medium |

### Code risks (owner: developer / team_lead)
| id | Condition | Severity |
|---|---|---|
| `code.large_pr` | pr_size > 800 LOC OR changed_files > 30 | medium |
| `code.risky_change` | change touches top hotspot AND coverage of change < 50% | high |
| `code.high_churn` | repo/path code_churn above baseline + rising | medium |
| `code.rework_spike` | rework_rate spikes vs baseline | medium |

### Review risks (owner: team_lead)
| id | Condition | Severity |
|---|---|---|
| `review.stale_pr` | open PR, time_to_first_review > 24h (→48h high) | medium→high |
| `review.rubber_stamp` | large PR approved with 0 comments | high |
| `review.self_merge` | self_merge on protected/high-risk repo | high |
| `review.reviewer_bottleneck` | one reviewer handles > 40% of team reviews | medium |
| `review.low_coverage` | review_coverage < 80% (rolling) | medium |

### Quality risks (owner: qa / eng_manager)
| id | Condition | Severity |
|---|---|---|
| `quality.coverage_drop` | coverage down > 5% over 2 sprints | medium |
| `quality.gate_failing_main` | quality gate failing on default branch | high |
| `quality.defect_density_rising` | defect_density > baseline + rising | medium |
| `quality.debt_trending_up` | technical_debt_ratio rising beyond threshold | medium |

### Release risks (owner: release / security)
| id | Condition | Severity |
|---|---|---|
| `release.low_confidence` | release_confidence < threshold | high |
| `release.open_critical_vuln` | open critical security_finding in release scope | critical |
| `release.cfr_trending_up` | change_failure_rate rising (rolling) | high |
| `release.unstable_builds` | build_success_rate < 85% (rolling) | medium |

### Developer risks *(supportive, team-level — owner: eng_manager)*
| id | Condition | Severity |
|---|---|---|
| `developer.burnout_signal` | sustained over-WIP + after-hours pattern (team-level) | medium |
| `developer.onboarding_stalled` | new joiner, no merged PR after N weeks | low |

> These are **support** signals, framed for help, RBAC-gated, never punitive (see ethics rules). They cannot produce individual rankings.

### Capacity risks (owner: eng_manager / scrum_master)
| id | Condition | Severity |
|---|---|---|
| `capacity.over_commitment` | committed points > historical capacity p85 | high |
| `capacity.workload_imbalance` | workload_balance dispersion above threshold | medium |
| `capacity.key_owner_overloaded` | bus-factor-1 owner also over-WIP | high |

### Architecture risks (owner: architect / eng_manager)
| id | Condition | Severity |
|---|---|---|
| `arch.bus_factor_one` | critical module bus_factor = 1 | high |
| `arch.debt_concentration` | rising debt concentrated in hotspot | medium |
| `arch.high_coupling` | dependency_risk cluster above threshold | medium |

---

## 5. Custom & tenant rules

- Tenants may **override** any default rule's thresholds/severity/enablement via `tenant_overrides` without forking.
- Tenants may **author** custom rules (same model) through an admin builder; custom rules are tenant-scoped and validated (safe expression, valid metric keys, valid owner_role).
- Rule packs are versioned; default-pack upgrades never silently overwrite tenant overrides.
- (Roadmap) Shareable rule-pack templates in a marketplace.

---

## 6. Agent enrichment & grounding

When a finding fires, the relevant persona agent (BC-11) may **enrich** it: add a plain-language explanation, cite the contributing metrics, and refine the recommendation (e.g., suggest the lowest-load reviewer). Constraints:

- The agent **does not invent the risk or its numbers** — severity and metric values come from the engine; the agent explains and recommends.
- Enrichment is grounded and cited (links to the same evidence).
- Any agent-proposed *action* (notify, post summary, open a ticket via the Collector's outbound client) follows human-in-the-loop approval and is audit-logged.

---

## 7. Notifications

Findings route to `owner_role`; notification delivery (if the tenant enabled it) goes through BC-15 native delivery to Slack/Teams/email ([api/README.md §8](../api/README.md)). Suppression/quiet-hours/throttling are resolved **before** emit. Critical-severity findings may bypass quiet hours per tenant policy.

---

## 8. Change policy

Adding/changing a rule or the engine: update this spec, register the rule definition, ensure the finding carries evidence + lineage + owner, add evaluation tests (incl. tenant isolation and dedupe/debounce), and confirm any consumed metric exists in [METRICS.md](METRICS.md). Ethics review required for any rule touching individual-level signals.
