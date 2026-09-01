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
| `developer_identity` | `id`, `tenant_id`, `source_system`, `source_key`, `source_login?`, `email?`, `name?`, `canonical_developer_id`, `confidence`, `method`, `evidence` (JSONB), `linked_user_id?` | **Identity resolution**: maps many source identities (Git author, Jira account, SSO) to one canonical developer. Implemented as `correlation_developer_identity`, owned by BC-5 — GitHub (§3) and Jira assignees (§3.1); SSO is still open. |
| `developer` | `id`, `tenant_id`, `display_name`, `primary_team_id?` | Canonical person referenced by the graph & metrics. May or may not be a platform `user`. **Not yet implemented** — `developer_identity.canonical_developer_id` is the canonical person today (a login, or the git name/email where no account was matched). |
| `tenant_configuration` | `id`, `tenant_id`, `namespace` (`github`, `jira`, `llm`, `notifications`, `metrics`, `security`), `key`, `values` (JSONB), `secret_refs` (JSONB), `status` | Tenant-wide admin settings and policy defaults. Secret values are never stored here; only references to vault/KMS/env secret names. |
| `connection` | `id`, `tenant_id`, `source_system`, `name`, `config`, `secret_ref` (OAuth/app-install/PAT token), `webhook_secret_ref`, `sync_cursors` (JSONB), `rate_limit_state`, `status`, `last_sync_at`, `sync_lag`, `last_error`, `last_error_at` | BC-0 registry; one per Jira instance / GitHub org / etc. Holds collector credentials, webhook secrets, and per-entity poll cursors (all secrets by reference). `last_error` records why the most recent pass failed and is cleared on the next clean one — without it a rejected pass is indistinguishable from an idle healthy one, since both collect zero events and both stamp `last_sync_at`. |

> Identity resolution is a **core risk** (§16 R1). Links carry `confidence` and `method`; ambiguous matches are queued for review, not silently merged.

**Why this entity is load-bearing, and how the GitHub implementation works.**

A git identity and a GitHub account are not the same thing. GitHub populates `commit.author.login` only when the commit's email is a *verified* email on some account; otherwise the commit arrives carrying a name and an email and no login, while the same person's pull requests always carry `user.login`. Without resolution, one human is two records: read models filtered on the raw login return nothing for them, and a dashboard renders "0 commits" as though it were a fact about the person. On the reference tenant this affected **19.2% of all commits across 19 git identities** (api/README.md §12 #22).

`source_key` is the stable identity of what was observed — `login:<login>` when the source resolved an account, `email:<lowercased email>` when it did not. `canonical_developer_id` is what the read models group by. The resolution ladder runs strongest-evidence-first and stops at the first rung that answers, so a weaker rule can never override a stronger one:

| Rung | `method` | `confidence` | Evidence |
|---|---|---|---|
| 1 | `github_login` | 1.0 | The source resolved the account itself. |
| 2 | `email_exact` | 0.95 | This exact email appears on a commit GitHub *did* attribute. Only unambiguous mappings are used — an address seen under several logins identifies no one. |
| 3 | `name_normalized` | 0.8 | The git author name normalizes to exactly one known login. Normalization drops a trailing `_<shortcode>` (GitHub Enterprise Managed User logins are `<name>_<shortcode>`, a shape no git `user.name` carries) and every non-alphanumeric. |
| — | `unresolved` | 0 | No evidence. Gets its own canonical id so its work is still counted and still selectable, and is recorded as an `unresolved_identity` orphan. |

Matching is deliberately **not fuzzy** — no edit distance, no token subsets, no initials expansion. Attributing one colleague's commits to another is a worse failure than leaving them unattributed, so a name normalizing to more than one login resolves to nothing and is queued as an `ambiguous_identity` orphan. Machine addresses (`noreply@github.com`, `*@users.noreply.github.com`, `*[bot]*`) are excluded from email matching entirely; treating one as a person's address would merge everyone who ever used it.

Resolution is pure in-database work over already-collected facts — no external API calls, so the collector boundary is untouched — and idempotent, so it re-derives rather than accumulating. It runs on the 30-minute correlation sweep and on demand via `POST /admin/configurations/correlation/resolve-identities`. Re-running matters: a developer is unresolvable until their first PR supplies a login, so the schedule is what turns a new joiner's back-catalogue of commits from nobody's into theirs.

### 3.1 The Jira arm (`source_system = 'jira'`)

Added 2026-08-25 (api/README.md §12 #40). Until then `source_system` was a hardcoded `'github'` despite the column existing for `github | jira | sso`, so a person's **commits** and their **assigned work** had no join between them — which is what Engineering Activity §Watchlist needs to report work happening outside the plan (DASHBOARDS.md §4.4.5).

`resolveJiraAssignees` observes the distinct `(assignee_login, assignee_name)` pairs on `planning_story` and matches them into the canonical ids the GitHub pass has already minted. It therefore runs **strictly after** that pass in the same sweep: against an empty or stale roster it would resolve nothing and record every assignee as unmatched, which the board then publishes as a collapsed match rate.

**The ladder, strongest evidence first:**

| Rung | Method | Confidence | Basis |
|---|---|---|---|
| 1 | `email_exact` | 0.95 | `story.assignee_email` equals an address the person is already known to commit under. A fact about a key unique per human, not an inference. |
| 2 | `name_normalized` | 0.8 | The Jira **display name** normalizes to exactly one canonical developer. |
| 3 | `name_normalized` | 0.8 | The **account reference** does — Jira Server instances often use the corporate username; on Cloud it is an opaque `accountId` that never matches. |
| — | `unresolved` | 0 | Left as `jira:<ref>`, namespaced so it can never collide with a GitHub login, and orphaned for review. |

Rung 1 is the one worth having, and it exists **only where the instance discloses the address**. Jira Cloud omits `emailAddress` from the assignee object unless user-profile visibility permits it (Atlassian's post-2019 GDPR default is to hide it), so `story.assignee_email` is routinely null and the ladder degrades to rungs 2–3 — which is exactly the behaviour that shipped before emails were collected. Null means *"Jira would not tell us"*, never *"this person has no email"*.

The email index is built from **resolved GitHub identities**, not raw commit rows, so an address the GitHub pass recovered counts too: someone committing as `357486@corp.example` whose git name matched their login is reachable under that numeric address. Two exclusions are load-bearing — **machine addresses** (a platform is not a person) and **any address seen under more than one canonical developer** (a shared team mailbox would otherwise fuse those colleagues).

Ambiguity on the name rungs is orphaned rather than guessed, for a sharper reason than on the GitHub side: a coin flip here credits one person's tickets to another *and* reports the wronged party as working off-plan.

**Existing rows need the reconciler, not a re-walk.** The Jira envelope's idempotency key derives from the issue's `updated` timestamp, so re-collecting an unchanged issue produces an identical key and is dropped as a duplicate before the projector sees it. `POST /admin/configurations/jira/reconcile-assignee-emails` fills them in, keyed on the **assignee** rather than the story — an email is a fact about a person, so one issue per distinct assignee teaches us the address for every issue they hold (~217 assignees across ~6,000 stories is 3 requests, not 60). That keying also bounds the failure case: on an instance that withholds emails, a story-keyed reconciler on the 10-minute schedule would re-ask about every assigned story forever.

Two invariants follow, and both are enforced in code:

- **A Jira `source_key` never becomes a bare canonical id.** An unmatched assignee gets `jira:<ref>`, namespaced so it cannot collide with a GitHub login — without which `resolveJiraIdentity({login: 'octocat'})` would silently *become* the developer `octocat`.
- **Every read that answers "whose commit is this" filters `source_system = 'github'`.** `aliasesFor`, `attributionIndex`, `listDevelopers` and `attributionCoverage` share this table; unfiltered, a Jira `accountId` would enter `AttributionIndex.byLogin` (the map commit attribution is looked up in) and would widen a developer's commit query with an identifier git has never seen. Tested per-read (api/README.md §12 #41).

Because the bridge is the weak link, everything derived from it publishes `assigneeCoverage` and distinguishes **unmatched** (`null`) from **nothing assigned** (`false`). Those look identical on screen and are opposite findings — a data gap versus the finding itself.

---

## 4. Planning context (BC-3 — Jira)

| Entity | Key fields | Relationships |
|---|---|---|
| `project` | `id`, `tenant_id`, `connection_id`, `external_key`, `name` | has many epics, sprints |
| `epic` | `id`, `tenant_id`, `project_id`, `external_key`, `title`, `status`, `target_date?` | has many stories |
| `story` | `id`, `tenant_id`, `project_id`, `epic_id?`, `external_key` (e.g. `PAY-2231`), `type` (story/bug/task/spike), `status`, `status_category`, `story_points?`, `assignee_developer_id?`, `source_created_at?`, `created_at`, `resolved_at?` | has many subtasks; linked to PRs/commits via graph. `status_category` is the workflow-independent bucket (`new`/`indeterminate`/`done`) — status *names* are per-project and unbounded (a real site has `READY FOR ESTIMATION`, `Story has open defects`, `ACCEPTED IN UAT`…), so flow metrics classify on the category, never the name. **`source_created_at` (Jira's `fields.created`) is the item's real age; `created_at` is only when this row was inserted** — i.e. the backfill's run date. `lead_time` uses the former: measured from `created_at`, every item that existed before its first collection looks days old instead of months, and the resulting negative durations get silently filtered out rather than surfacing the error. Null for items collected before the field was requested, until the sync re-walks them — those are excluded from lead time and counted, never estimated. |
| `subtask` | `id`, `tenant_id`, `story_id`, `external_key`, `status` | |
| `sprint` | `id`, `tenant_id`, `project_id`, `external_id`, `name`, `state`, `start_at`, `end_at` | has many stories (scope) |
| `sprint_scope_change` | `id`, `tenant_id`, `connection_id`, `external_key`, `sprint_external_id`, `action` (added/removed), `changelog_id`, `changed_at`, `author_login?`, `author_name?` | **Basis for sprint_commitment_reliability and scope_creep.** Append-only sprint-membership timeline from Jira's own change log — implemented as `planning_sprint_scope_change`, replacing the interval-shaped `sprint_scope` design (`added_at`/`removed_at`/`committed` on one row): intervals must be *updated* on replay, which fights the replay-safe `createMany(skipDuplicates)` contract, so the event log is stored and membership-as-of-a-date is replayed at read time. One changelog entry touching several sprints (a move: removed A, added B) lands as one row per sprint, unique on `(tenant_id, connection_id, changelog_id, sprint_external_id)`. A story created directly into a sprint has no changelog entry — no `added` row plus current membership (or a later `removed` row) means "member since `story.source_created_at`". |
| `issue_status_history` | `id`, `tenant_id`, `connection_id`, `external_key`, `changelog_id`, `from_status?`, `to_status`, `transitioned_at`, `author_login?`, `author_name?` | **Basis for cycle/lead/blocked time.** Append-only. Implemented as `planning_issue_status_history`. |

`external_key` (the Jira key) is the join target for correlation.

`issue_status_history` keys on `external_key` rather than a `story_id` foreign key, and carries the source system's own `changelog_id` instead of a `source_event_id`. Both follow from how the timeline is collected: transitions arrive attached to the issue in the same payload as the story itself, so keying on `(tenant_id, connection_id, changelog_id)` makes a backfill re-walk, a boundary re-poll, and a webhook for an already-polled transition all converge on one row. Inserting the same transition twice would silently inflate every duration derived from it, which is the failure mode this key exists to prevent.

---

## 5. Code context (BC-4 — Git)

| Entity | Key fields | Relationships |
|---|---|---|
| `repository` | `id`, `tenant_id`, `connection_id`, `external_id`, `full_name` (`acme/payments`), `default_branch` | has many PRs/commits/branches |
| `branch` | `id`, `tenant_id`, `repository_id`, `name`, `created_at`, `deleted_at?` | name parsed for issue keys |
| `pull_request` | `id`, `tenant_id`, `repository_id`, `external_number`, `title`, `state` (open/merged/closed), `author_developer_id`, `branch`, `base_branch`, `additions`, `deletions`, `changed_files`, `opened_at`, `first_review_at?`, `approved_at?`, `merged_at?`, `merged_by?`, `reviews_fetched_at?`, `commits_fetched_at?` | has many commits, reviews; **timestamps drive PR/review metrics**. `detail_fetched_at`, `reviews_fetched_at` and `commits_fetched_at` are **asked-about** markers, not filled-in markers — the distinction the unattended backfill sweep depends on (api/README.md §3.2). A PR with a genuinely empty diff stays at 0/0/0 and one merged by a since-deleted account has `merged_by` null forever; without a record that we already asked, both stay reconciler candidates permanently and get re-fetched every tick. `reviews_fetched_at` additionally separates "this PR genuinely had no reviews" from "we never asked" — the two are otherwise the same absence of `pr_review` rows, and conflating them reports incomplete collection as an alarming self-merge rate. `commits_fetched_at` does the same for `commit_messages`, which correlation reads as a Jira-key source: an empty list on a never-asked PR is collection absence disguised as "carries no key". Both stamped even when the fetch returned zero rows, because that is itself an answer. |
| `commit` | `id`, `tenant_id`, `repository_id`, `sha`, `message`, `author_developer_id`, `authored_at`, `additions`, `deletions`, `files_changed` | linked to PR & story via graph |
| `pr_review` | `id`, `tenant_id`, `connection_id`, `repo_full_name`, `external_number`, `external_id`, `reviewer_login?`, `state` (approved/changes_requested/commented/dismissed), `comment_count`, `has_body`, `submitted_at` | review depth/latency/load. Implemented as `code_pr_review`. Addresses its PR by `(repo_full_name, external_number)` rather than a `pull_request_id` FK — external ids stay VARCHAR, matching every other fact here. Unique on `(tenant_id, external_id)` — GitHub's own review id — so a backfill re-walk and a later incremental poll converge on one row instead of inflating every count derived from it. Reviews are immutable once submitted, so there is nothing to update on conflict. `comment_count` is 0 until the inline-comments endpoint is collected (`review_depth` in METRICS.md); `has_body` is the available substantive signal and is **not** a substitute for it. |
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
| `developer_authored` | developer → commit/pr | identity resolution | `confidence` — **not materialized as a `correlation_link` row**; authorship is resolved at read time through `developer_identity` (§3) |
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
