# SprintIQ Data Model & Delivery Graph

Authoritative reference for SprintIQ's logical data model — the raw-event store, the per-context domain models, and the **unified delivery graph** that is the platform's moat.

> See [PRODUCT-ARCHITECTURE.md](PRODUCT-ARCHITECTURE.md) for context (BC-5 Correlation, BC-8 Metrics, §12 Event Flow). This document defines *logical* entities, keys, relationships, and tenancy/lineage rules. It is database-engine-agnostic (target: PostgreSQL + `pgvector`); physical DDL and migrations live with the implementation.

---

## 0. Modeling principles

1. **Tenant-first.** Every persisted row carries `tenant_id`. No entity is global except the platform's own config. All queries filter by `tenant_id`.
2. **External IDs are strings.** IDs originating in source systems (`repo`, `pr_number`, `issue_key`, `commit_sha`, `build_id`, source logins) are stored as `VARCHAR` exactly as received. SprintIQ mints its own internal surrogate keys (ULIDs) for joins; it never re-mints external IDs as UUIDs.
3. **Facts are append-friendly + time-aware.** Domain entities keep current state *and* a status/transition history so flow metrics (cycle/lead time, blocked time) are reconstructable.
4. **Raw is sacred.** The raw event store is append-only and replayable. Normalized models are derived; they can be rebuilt from raw.
5. **Lineage everywhere.** Every normalized fact, metric value, and risk finding references the event(s) that produced it.
6. **Confidence is explicit.** Correlation links carry a confidence score and method; low-confidence/orphan links are surfaced, never hidden.
7. **Context ownership.** Each bounded context owns its tables. Cross-context references use internal IDs through interfaces/events — no foreign context reads another's tables directly (keeps the modular monolith extractable).

---

## 1. Layered model overview

```
                ┌──────────────────────────────────────────────┐
  collectors ►  │ RAW EVENT STORE (append-only, replayable)     │  BC-1
                │   raw_event(tenant, source, type, envelope...) │
                └───────────────────────┬──────────────────────┘
                                         │ normalize
        ┌────────────────────────────────┼────────────────────────────────┐
        ▼                ▼                ▼               ▼                 ▼
   PLANNING (BC-3)   CODE (BC-4)     CI/CD (BC-6)   QUALITY (BC-7)   IDENTITY (BC-2)
   project/epic/     repo/pr/        build/deploy/  scan/finding/    org/team/user/
   story/sprint      commit/review   release        quality_gate     developer_identity
        └────────────────────────────────┼────────────────────────────────┘
                                         │ correlate (BC-5)
                ┌──────────────────────────────────────────────┐
                │ DELIVERY GRAPH  (nodes + typed, scored edges) │  ★ moat
                └───────────────────────┬──────────────────────┘
                                         │ aggregate
        ┌────────────────────────────────┼────────────────────────────────┐
        ▼                                ▼                                 ▼
   METRICS (BC-8)                  RISK FINDINGS (BC-9)          ANALYTICS (BC-10)
   metric_value / rollup           rule_finding                 hotspot/ownership/network
        └───────────► RECOMMENDATIONS (BC-14) ◄── AGENTS (BC-11) ── MEMORY/EMBEDDINGS (BC-12)
```

---

## 2. Raw event store (BC-1)

| Entity | Key fields | Notes |
|---|---|---|
| `raw_event` | `id` (ULID, PK), `tenant_id`, `connection_id`, `source_system`, `collection_mode` (webhook/poll/backfill), `event_type`, `idempotency_key`, `occurred_at`, `collected_at`, `ingested_at`, `envelope` (JSONB), `processing_status`, `processed_at` | Append-only. **Unique** `(tenant_id, idempotency_key)` enforces effectively-once across webhooks and pollers. `envelope` keeps the full payload (forward-compatible). |
| `dead_letter_event` | `id`, `tenant_id`, `raw_event_id?`, `reason`, `payload`, `created_at` | Validation/processing failures for replay & alerting. |

`processing_status`: `received → normalized → correlated → failed`. Replay = re-run normalization over `raw_event` rows.

---

## 3. Identity & tenancy (BC-2)

| Entity | Key fields | Notes |
|---|---|---|
| `tenant` | `id`, `name`, `plan`, `region`, `status` | Top isolation boundary. |
| `organization` | `id`, `tenant_id`, `name` | A tenant may map orgs/divisions. |
| `team` | `id`, `tenant_id`, `org_id`, `name` | Primary aggregation unit for metrics. |
| `user` | `id`, `tenant_id`, `email` (**globally unique**), `display_name`, `status`, `sso_subject?`, `roles[]` | Platform users (the people who log in). Email is globally unique — a user belongs to exactly one tenant, so login resolves the tenant from the user (ADR-0006). |
| `role` / `user_role` | RBAC | Roles: developer, team_lead, scrum_master, eng_manager, product_owner, cto, exec, admin. |
| `developer_identity` | `id`, `tenant_id`, `canonical_developer_id`, `source_system`, `source_login`, `email?`, `confidence`, `linked_user_id?` | **Identity resolution**: maps many source logins (Git author, Jira account, SSO) to one canonical developer. |
| `developer` | `id`, `tenant_id`, `display_name`, `primary_team_id?` | Canonical person referenced by the graph & metrics. May or may not be a platform `user`. |
| `connection` | `id`, `tenant_id`, `source_system`, `name`, `config`, `secret_ref` (OAuth/app-install/PAT token), `webhook_secret_ref`, `sync_cursors` (JSONB), `rate_limit_state`, `status`, `last_sync_at`, `sync_lag` | BC-0 registry; one per Jira instance / GitHub org / etc. Holds collector credentials, webhook secrets, and per-entity poll cursors (all secrets by reference). |

> Identity resolution is a **core risk** (§16 R1). Links carry `confidence` and `method`; ambiguous matches are queued for review, not silently merged.

---

## 4. Planning context (BC-3 — Jira)

| Entity | Key fields | Relationships |
|---|---|---|
| `project` | `id`, `tenant_id`, `connection_id`, `external_key`, `name` | has many epics, sprints |
| `epic` | `id`, `tenant_id`, `project_id`, `external_key`, `title`, `status`, `target_date?` | has many stories |
| `story` | `id`, `tenant_id`, `project_id`, `epic_id?`, `external_key` (e.g. `PAY-2231`), `type` (story/bug/task/spike), `status`, `story_points?`, `assignee_developer_id?`, `created_at`, `resolved_at?` | has many subtasks; linked to PRs/commits via graph |
| `subtask` | `id`, `tenant_id`, `story_id`, `external_key`, `status` | |
| `sprint` | `id`, `tenant_id`, `project_id`, `external_id`, `name`, `state`, `start_at`, `end_at` | has many stories (scope) |
| `sprint_scope` | `sprint_id`, `story_id`, `added_at`, `removed_at?`, `committed` (bool) | Captures scope changes → scope-creep metric. |
| `issue_status_history` | `id`, `tenant_id`, `story_id`, `from_status`, `to_status`, `changed_at`, `source_event_id` | **Basis for cycle/lead/blocked time.** Append-only. |

`external_key` (the Jira key) is the join target for correlation.

---

## 5. Code context (BC-4 — Git)

| Entity | Key fields | Relationships |
|---|---|---|
| `repository` | `id`, `tenant_id`, `connection_id`, `external_id`, `full_name` (`acme/payments`), `default_branch` | has many PRs/commits/branches |
| `branch` | `id`, `tenant_id`, `repository_id`, `name`, `created_at`, `deleted_at?` | name parsed for issue keys |
| `pull_request` | `id`, `tenant_id`, `repository_id`, `external_number`, `title`, `state` (open/merged/closed), `author_developer_id`, `branch`, `base_branch`, `additions`, `deletions`, `changed_files`, `opened_at`, `first_review_at?`, `approved_at?`, `merged_at?`, `merged_by_developer_id?` | has many commits, reviews; **timestamps drive PR/review metrics** |
| `commit` | `id`, `tenant_id`, `repository_id`, `sha`, `message`, `author_developer_id`, `authored_at`, `additions`, `deletions`, `files_changed` | linked to PR & story via graph |
| `pr_review` | `id`, `tenant_id`, `pull_request_id`, `reviewer_developer_id`, `state` (approved/changes/commented), `comment_count`, `submitted_at` | review depth/latency/load |
| `file_change` | `id`, `tenant_id`, `commit_id`, `path`, `additions`, `deletions`, `change_type` | feeds hotspots/ownership |
| `code_owner` | `repository_id`, `path_pattern`, `developer_id` | CODEOWNERS for ownership analytics |

---

## 6. CI/CD context (BC-6)

| Entity | Key fields |
|---|---|
| `pipeline` | `id`, `tenant_id`, `connection_id`, `repository_id?`, `external_id`, `name` |
| `build` | `id`, `tenant_id`, `pipeline_id`, `external_id`, `status` (succeeded/failed), `commit_sha?`, `started_at`, `finished_at`, `duration_ms` |
| `deployment` | `id`, `tenant_id`, `environment`, `status`, `release_id?`, `commit_sha?`, `started_at`, `finished_at` |
| `release` | `id`, `tenant_id`, `repository_id?`, `version`, `published_at` |
| `environment` | `id`, `tenant_id`, `name`, `kind` (dev/stage/prod) |

DORA metrics derive from `deployment` (frequency, lead-time-to-deploy), `build`/`deployment` failure outcomes (change-failure-rate), and incident/restore signals (MTTR, future integration).

---

## 7. Quality & security context (BC-7)

| Entity | Key fields |
|---|---|
| `quality_scan` | `id`, `tenant_id`, `connection_id`, `repository_id?`, `commit_sha?`, `coverage`, `duplication`, `smells`, `complexity`, `scanned_at` |
| `quality_gate_result` | `id`, `tenant_id`, `scan_id`, `gate`, `status` (passed/failed), `conditions` (JSONB) |
| `security_finding` | `id`, `tenant_id`, `repository_id?`, `severity`, `rule`, `cve?`, `state` (open/resolved), `opened_at`, `resolved_at?`, `dependency?` |

---

## 8. The delivery graph (BC-5) ★

The graph is materialized as **nodes** (references to context entities) and **typed, scored edges**.

### 8.1 Nodes
A `graph_node` references an existing entity (no data duplication): `(node_id, tenant_id, node_type, entity_ref)` where `node_type ∈ {project, epic, story, subtask, sprint, repository, branch, pull_request, commit, build, deployment, release, developer}`.

### 8.2 Edges

| Edge | From → To | How derived | Carries |
|---|---|---|---|
| `commit_implements_story` | commit → story | Jira-key in commit message | `confidence`, `method`, `source_event_id` |
| `pr_implements_story` | pull_request → story | key in PR title/branch + member commits | `confidence`, `method` |
| `pr_contains_commit` | pull_request → commit | source link | structural (confidence 1.0) |
| `story_in_epic` | story → epic | planning data | structural |
| `epic_in_project` | epic → project | planning data | structural |
| `story_in_sprint` | story → sprint | sprint scope | structural + `committed` |
| `commit_in_repo` / `pr_in_repo` | → repository | structural | |
| `deployment_includes_commit` | deployment → commit | CI metadata | for lead-time-to-deploy & release scope |
| `developer_authored` | developer → commit/pr | identity resolution | `confidence` |
| `scan_covers_commit` | quality_scan → commit | commit_sha match | |

### 8.3 Correlation record & coverage

| Entity | Key fields | Purpose |
|---|---|---|
| `correlation_link` | `id`, `tenant_id`, `edge_type`, `from_node`, `to_node`, `confidence` (0–1), `method` (`regex`/`heuristic`/`ml`/`manual`/`structural`), `evidence` (JSONB), `source_event_id`, `created_at`, `superseded_by?` | The auditable backbone of every non-structural edge. Manual overrides supersede automatic links. |
| `orphan` | `id`, `tenant_id`, `node_type`, `node_ref`, `reason` (`no_key`/`ambiguous_key`/`unknown_project`), `detected_at`, `resolved_at?` | PRs/commits/stories that could not be linked confidently — **surfaced**, never guessed. Powers linkage-coverage transparency. |

**Jira-key extraction** runs `regex` (e.g. `[A-Z][A-Z0-9]+-\d+`) over branch, PR title, and commit messages, validates the project key against known `project.external_key`s, and falls back to heuristics/ML for near-misses. Confidence reflects match strength and validation. Coverage = linked / total per repo/team → a first-class **metric health** signal on dashboards.

---

## 9. Metrics context (BC-8)

| Entity | Key fields | Notes |
|---|---|---|
| `metric_definition` | `key`, `name`, `family`, `unit`, `window`, `formula_ref`, `dimensions` | Catalog of metrics (see architecture §8). |
| `metric_value` | `id`, `tenant_id`, `metric_key`, `scope_type` (developer/team/repo/project/org/sprint), `scope_id`, `period_start`, `period_end`, `value`, `sample_size`, `lineage` (event/link refs), `computed_at` | Time-series fact. `lineage` enables drill-to-evidence. |
| `composite_score` | `id`, `tenant_id`, `score_key` (sprint_health/repo_health/release_confidence/…), `scope`, `value` (0–100), `components` (JSONB weights+inputs), `period`, `computed_at` | Explainable: `components` shows exactly what drove the score. |
| `metric_health` | `tenant_id`, `scope`, `linkage_coverage`, `data_freshness`, `confidence`, `computed_at` | Trustworthiness shown alongside numbers. |

---

## 10. Rules, risk & recommendations (BC-9, BC-14)

| Entity | Key fields |
|---|---|
| `rule` | `id`, `tenant_id?` (null = platform default), `name`, `family`, `scope`, `condition` (expression), `severity_policy`, `recommendation_template`, `owner_role`, `enabled`, `suppression`, `escalation` |
| `rule_finding` | `id`, `tenant_id`, `rule_id`, `scope_type`, `scope_id`, `severity`, `evidence` (metric/link refs), `recommendation`, `owner_role`, `status` (open/ack/resolved/suppressed), `detected_at`, `dedupe_key`, `escalated_at?` |
| `recommendation` | `id`, `tenant_id`, `source` (rule/agent), `finding_id?`, `title`, `body`, `owner`, `state` (proposed/accepted/dismissed/snoozed/acted), `decided_by?`, `decided_at?`, `outcome` (improved/no_change/worsened/unknown), `effectiveness_score?` | The decision feedback loop. `outcome` is measured later → feeds agent memory. |

---

## 11. Analytics context (BC-10)

Materialized/derived views over the graph + history:

| Entity | Key fields |
|---|---|
| `repo_hotspot` | `tenant_id`, `repository_id`, `path`, `churn`, `complexity`, `defect_links`, `risk_score`, `period` |
| `code_ownership` | `tenant_id`, `repository_id`, `path`, `developer_id`, `ownership_pct`, `bus_factor` |
| `collaboration_edge` | `tenant_id`, `developer_a`, `developer_b`, `interaction_type` (co-review/co-commit), `weight`, `period` |
| `dependency_risk` | `tenant_id`, `repository_id`, `dependency`, `risk`, `reason` |
| `forecast` | `tenant_id`, `target_type` (epic/sprint/release), `target_id`, `predicted_date`, `confidence`, `method`, `computed_at` |

---

## 12. AI memory & knowledge (BC-12)

| Entity | Key fields |
|---|---|
| `embedding` | `id`, `tenant_id`, `object_type`, `object_ref`, `vector` (pgvector), `model`, `created_at` | RAG over graph/metrics/docs. Tenant-isolated. |
| `agent_memory` | `id`, `tenant_id`, `agent_key`, `memory_type` (episodic/semantic/decision/working), `scope`, `content`, `created_at` | Per-agent, per-tenant. Decision memory links to `recommendation.outcome`. |
| `agent_run` | `id`, `tenant_id`, `agent_key`, `trigger`, `inputs_ref`, `tools_called` (JSONB), `output_ref`, `tokens`, `cost`, `started_at`, `finished_at` | Governance + audit + cost tracking. |

---

## 13. Audit & lineage (BC-16)

| Entity | Key fields |
|---|---|
| `audit_log` | `id`, `tenant_id`, `actor_type` (user/agent/system), `actor_id`, `action`, `target_type`, `target_id`, `metadata`, `created_at` | All user **and agent** actions. |
| `lineage_link` | `derived_type` (metric_value/composite_score/rule_finding), `derived_id`, `source_type` (raw_event/correlation_link/metric_value), `source_id` | The chain that lets any dashboard number trace to source events. |

---

## 14. Cross-cutting rules (enforced in code & tests)

- **Tenant scope:** composite indexes lead with `tenant_id`; repository/query layer injects `tenant_id`; isolation tests assert no cross-tenant read path exists.
- **Soft lifecycle:** domain entities prefer state + history over destructive deletes; raw events are never deleted (retention policy archives, not drops).
- **No cross-context FK to another context's internal tables** — reference by internal ID through the owning context's interface/events, keeping contexts independently extractable.
- **Confidence & coverage are first-class** — never present a correlated number without access to its confidence/coverage.
- **Schema changes** follow Documentation-First: update this doc + the affected context, note migration impact, and add isolation/lineage tests (per `CLAUDE.md` / `AGENTS.md`).
