# Metric Specification Catalog

Authoritative definitions for every metric SprintIQ computes — exact inputs, formula, window, dimensions, and the data it traces back to. This is the contract the Metrics Engine (BC-8) implements and that agents, rules, and dashboards depend on.

> Context: [PRODUCT-ARCHITECTURE.md §8](../architecture/PRODUCT-ARCHITECTURE.md) (the metric inventory) and [DATA-MODEL.md](../architecture/DATA-MODEL.md) (`metric_definition`, `metric_value`, `composite_score`, `metric_health`, `lineage_link`). This doc adds the *math and rules*. Any change to a definition updates this file (Documentation-First).

---

## 0. Conventions

- **Dimensions (scope):** every metric is computable at one or more of `developer · team · repo · project · org · sprint · tenant`. Default presentation scope is **team** (ethics rule). Listed per metric as **Scopes**.
- **Window:** the time basis — `sprint`, `rolling Nd` (rolling N days), `period` (caller-selected range), or `point-in-time`.
- **Percentiles:** distribution metrics report **p50 / p85** (and mean) — not just average. p85 is the headline for cycle/lead/review times (tail is what hurts).
- **Lineage:** each `metric_value` stores the `event`/`link` refs that produced it; every number drills to evidence.
- **Metric health:** each value is paired with `linkage_coverage` + `data_freshness` + `confidence` so consumers know how much to trust it. **A metric below its coverage floor is shown as "low confidence," never silently.**
- **Ethics:** individual-scope values are diagnostic/supportive, RBAC-gated, never ranked. Anti-vanity metrics (LOC, commit count) are explicitly labeled *context, not performance*.
- **Exclusions (global defaults):** bot/automation accounts excluded from people metrics; merge commits excluded from authorship churn; reverts flagged; draft PRs excluded from review-time until marked ready. Exclusions are configurable per tenant and recorded in `metric_definition`.

Each metric below: **Definition · Formula · Window · Scopes · Source · Notes/edge-cases.**

---

## 1. Flow & Delivery (Planning + graph)

### velocity
- **Definition:** completed story points per sprint.
- **Formula:** `Σ story_points where story.resolved_at ∈ sprint AND status ∈ done-set`.
- **Window:** sprint (+ rolling 3/6-sprint avg & variance).
- **Scopes:** team, project, sprint.
- **Source:** `story`, `sprint_scope`, `issue_status_history`.
- **Notes:** report **rolling average + variance**, never a single sprint as "the number." Unpointed stories tracked separately (count) so velocity isn't silently understated.

### throughput
- **Definition:** count of work items completed per period, by type.
- **Formula:** `count(story where resolved_at ∈ period)` grouped by `type`.
- **Window:** rolling 30d / period. **Scopes:** team, project, developer*, repo (via linked work).
- **Source:** `story`. **Notes:** complements velocity for teams that don't point.

### cycle_time
- **Definition:** active development duration of a work item.
- **Formula:** `first_done_at − first_in_progress_at` (or first linked commit if earlier), from `issue_status_history`. Report p50/p85.
- **Window:** rolling 30/90d. **Scopes:** team, project, developer*, story-type.
- **Source:** `issue_status_history`, graph (`commit_implements_story`).
- **Notes:** if no in-progress transition exists, fall back to first-linked-commit timestamp; flag estimation method in lineage.

### lead_time
- **Definition:** total time from request to delivery.
- **Formula:** `resolved_at − created_at` (p50/p85).
- **Window:** rolling 30/90d. **Scopes:** team, project, story-type.
- **Source:** `story`.

### lead_time_for_changes *(DORA)*
- **Definition:** time from code committed to running in production.
- **Formula:** `deployment.finished_at(prod) − commit.authored_at`, over commits in that deploy (p50/p85).
- **Window:** rolling 30/90d. **Scopes:** repo, team, project, org.
- **Source:** `commit`, `deployment`, `deployment_includes_commit`.

### sprint_commitment_reliability
- **Definition:** how much of the committed scope was delivered.
- **Formula:** `completed_committed_points / committed_points_at_sprint_start`.
- **Window:** sprint. **Scopes:** team, sprint.
- **Source:** `sprint_scope` (`committed=true`, `added_at ≤ start`), `story`.
- **Notes:** excludes mid-sprint additions from the denominator; those feed scope_creep.

### scope_creep
- **Definition:** scope added/removed after sprint start.
- **Formula:** `(points_added_after_start − points_removed_after_start) / committed_points`.
- **Window:** sprint. **Scopes:** team, sprint. **Source:** `sprint_scope`.

### wip
- **Definition:** concurrent in-progress items; and **wip_age** (how long they've been open).
- **Formula:** `count(story where status ∈ in-progress-set at t)`; age = `now − in_progress_at`.
- **Window:** point-in-time + trend. **Scopes:** team, developer*.
- **Source:** `issue_status_history`. **Notes:** high WIP × high age is the bottleneck signal feeding rules.

### flow_efficiency
- **Definition:** fraction of cycle time spent actively working vs waiting.
- **Formula:** `active_time / (active_time + wait_time)` where wait = time in blocked/queue/review-wait states.
- **Window:** rolling 30/90d. **Scopes:** team, project.
- **Source:** `issue_status_history`. **Notes:** the single best "where's the friction" flow metric; <40% is typically alarming.

### blocked_time
- **Definition:** time work items spend blocked/waiting.
- **Formula:** `Σ duration in blocked-set states`. **Window:** sprint/rolling. **Scopes:** team, story.
- **Source:** `issue_status_history`.

### aging_work_items
- **Definition:** items exceeding an age threshold for their status.
- **Formula:** `count where (now − status_entered_at) > threshold(status)`. **Window:** point-in-time. **Scopes:** team, developer*.
- **Source:** `issue_status_history`. **Notes:** threshold configurable per tenant.

### planning_accuracy
- **Definition:** estimate vs actual.
- **Formula:** `1 − |actual_cycle − estimate| / estimate` (clamped ≥0), aggregated. **Window:** rolling. **Scopes:** team.
- **Source:** `story.story_points`, `cycle_time`.

---

## 2. Code Throughput (Git)

### pr_throughput
- **Definition:** PRs opened/merged per period.
- **Formula:** counts of `pull_request` by `opened_at` / `merged_at`. **Window:** rolling 30d. **Scopes:** repo, team, developer*. **Source:** `pull_request`.

### pr_size
- **Definition:** change size per PR; and **large_pr_rate**.
- **Formula:** `additions + deletions` and `changed_files` per PR (p50/p85); large_pr_rate = `count(size > threshold)/count(PRs)`. **Window:** rolling. **Scopes:** repo, team, developer*. **Source:** `pull_request`.
- **Notes:** large PRs correlate with slow review and escaped defects → feeds Code/Review risks.

### pr_cycle_time
- **Definition:** open → merge, with sub-phases.
- **Formula:** `merged_at − opened_at`; sub-phases: `time_to_first_review = first_review_at − opened_at`, `review_time = approved_at − first_review_at`, `merge_time = merged_at − approved_at` (all p50/p85). **Window:** rolling 30d. **Scopes:** repo, team, developer*. **Source:** `pull_request`, `pr_review`.
- **Notes:** draft time excluded; the sub-phase breakdown is what makes bottlenecks actionable.

### time_to_first_review
- See pr_cycle_time sub-phase. Headline review-responsiveness metric. **Scopes:** repo, team, reviewer.

### commit_frequency / developer_activity
- **Definition:** commits per period — **context, never a productivity score**.
- **Formula:** `count(commit by author in period)`. **Window:** rolling 30d. **Scopes:** team, developer* (self/manager view only). **Source:** `commit`.
- **Notes:** explicitly anti-vanity; UI labels it "activity context." Never ranked.

### loc_added_deleted
- **Definition:** lines added/deleted — **diagnostic only**.
- **Formula:** `Σ additions`, `Σ deletions`. **Window:** rolling. **Scopes:** repo, project, team, developer* (supportive activity context only). **Source:** `commit`/`file_change`; current dashboard implementation uses merged PR additions/deletions by PR author until commit/file-change facts land.
- **Notes:** **never** a performance or productivity metric (hard rule). Used only for churn/size/activity context; never ranked or scored.

### code_churn
- **Definition:** share of recently-written code that is rewritten/deleted soon after.
- **Formula:** `lines_modified_or_deleted_within_N_days_of_authoring / lines_authored` (default N=21d). **Window:** rolling. **Scopes:** repo, team, path. **Source:** `file_change`, `commit`.
- **Notes:** high churn = rework/instability signal; feeds hotspots and change-risk.

### rework_rate
- **Definition:** changes touching code merged very recently (e.g., <14d).
- **Formula:** `lines_changed_on_recent_code / total_lines_changed`. **Window:** rolling. **Scopes:** repo, team. **Source:** `file_change` history.

### files_changed / change_spread
- **Definition:** breadth of a change. **Formula:** `changed_files` per PR/commit; spread = distinct top-level dirs touched. **Scopes:** repo, PR. **Source:** `pull_request`, `file_change`.

---

## 3. Review Quality (Git)

### review_coverage
- **Definition:** share of merged PRs with ≥1 substantive review.
- **Formula:** `count(PR with ≥1 review having comments OR approval by non-author) / count(merged PR)`. **Window:** rolling 30d. **Scopes:** repo, team. **Source:** `pull_request`, `pr_review`.

### reviewer_load / distribution
- **Definition:** reviews per reviewer and concentration.
- **Formula:** counts per reviewer; concentration = Gini or top-reviewer share of team reviews. **Window:** rolling. **Scopes:** team, reviewer. **Source:** `pr_review`.
- **Notes:** high concentration = review bottleneck + bus-factor signal.

### review_depth
- **Definition:** scrutiny per PR; and **rubber_stamp_rate**.
- **Formula:** `comments_per_PR` (p50); rubber_stamp_rate = `count(approved with 0 comments AND size > threshold)/count(approved large PRs)`. **Window:** rolling. **Scopes:** repo, team. **Source:** `pr_review`, `pull_request`.

### self_merge_rate
- **Definition:** PRs merged by author without independent review.
- **Formula:** `count(merged_by = author AND no non-author approval)/count(merged)`. **Window:** rolling. **Scopes:** repo, team, developer*. **Source:** `pull_request`, `pr_review`.

### review_latency
- **Definition:** responsiveness of the review system (= time_to_first_review, p50/p85). **Scopes:** repo, team, reviewer.

---

## 4. Reliability / DORA (CI/CD)

### deployment_frequency
- **Definition:** successful production deploys per period.
- **Formula:** `count(deployment where env=prod AND status=succeeded)/period`. **Window:** rolling 30d. **Scopes:** repo, team, org, project. **Source:** `deployment`.

### change_failure_rate *(DORA)*
- **Definition:** share of deploys that cause a failure (rollback/incident/hotfix).
- **Formula:** `failed_or_rolled_back_prod_deploys / total_prod_deploys`. **Window:** rolling 30/90d. **Scopes:** repo, team, org. **Source:** `deployment` (+ incident signal when integrated).
- **Notes:** until incident integration lands, approximated via rollback deploys + hotfix-tagged changes; method recorded in lineage.

### mttr *(DORA, mean time to restore)*
- **Definition:** time from failure to restoration.
- **Formula:** `restore_time − failure_time` (p50/mean). **Window:** rolling 90d. **Scopes:** repo, team, org. **Source:** incident/deploy signals.
- **Notes:** requires incident integration (PagerDuty/Opsgenie) for fidelity; flagged as estimate otherwise.

### build_success_rate / build_duration
- **Formula:** `succeeded_builds/total_builds`; duration p50/p85. **Window:** rolling 30d. **Scopes:** pipeline, repo, team. **Source:** `build`.

### deploy_stability / rollback_rate
- **Formula:** `rollback_deploys/total_deploys`. **Window:** rolling. **Scopes:** repo, env, team. **Source:** `deployment`.

---

## 5. Quality & Security (Sonar/scanners)

### test_coverage (+ coverage_trend)
- **Formula:** latest `quality_scan.coverage`; trend = slope over rolling window. **Scopes:** repo, project. **Source:** `quality_scan`.

### defect_density
- **Definition:** bugs relative to size/output.
- **Formula:** `count(bug stories) / KLOC` (or per N delivered stories). **Window:** rolling 90d. **Scopes:** repo, team, project. **Source:** `story(type=bug)`, churn.

### bug_count
- **Definition:** bug work items in the selected delivery scope.
- **Formula:** `count(distinct story where type=bug)`; repo scope uses PR→story correlation, project scope uses project stories.
- **Window:** period / rolling. **Scopes:** repo, project, team. **Source:** `story(type=bug)`, graph (`pr_implements_story`).
- **Notes:** dashboard context metric for "bug-wise" slicing; current implementation windows by `story.updatedAt` until status-history/resolution timestamps are modeled.

### escaped_defects
- **Definition:** bugs discovered after release.
- **Formula:** `count(bug created after the release that introduced the related change)`. **Window:** per release / rolling. **Scopes:** repo, team, release. **Source:** `story(type=bug)`, `release`, graph links.

### code_smells / duplication / complexity
- **Formula:** latest values from `quality_scan` + trend. **Scopes:** repo, path. **Source:** `quality_scan`.

### quality_gate_pass_rate
- **Formula:** `passed_gate_evaluations/total`. **Window:** rolling. **Scopes:** repo, project. **Source:** `quality_gate_result`.

### open_vulnerabilities / mttr_vuln
- **Formula:** `count(security_finding where state=open)` by severity; mttr_vuln = `resolved_at − opened_at` (by severity). **Scopes:** repo, project, org. **Source:** `security_finding`.

### dependency_risk / outdated_dependencies
- **Formula:** count/severity of risky or outdated deps. **Scopes:** repo. **Source:** `security_finding(dependency)`, analytics.

### technical_debt_ratio (+ trend)
- **Definition:** remediation cost vs development cost.
- **Formula:** `remediation_effort / development_effort` (Sonar debt ratio) + slope. **Scopes:** repo, project. **Source:** `quality_scan`.

---

## 6. Progress & Predictability

### epic_progress
- **Definition:** completion of an epic + projection.
- **Formula:** `done_points / total_points` (and item-count variant); projected_completion via velocity of contributing teams. **Window:** point-in-time + trend. **Scopes:** epic, project. **Source:** `epic`, `story`, `velocity`.

### project_progress / milestone_burnup
- **Formula:** rollup of epic_progress / completed vs scope over time. **Scopes:** project, release. **Source:** `epic`, `story`, `release`.

### predicted_delivery_date (+ forecast confidence)
- **Definition:** projected completion date for sprint/epic/release with interval.
- **Formula:** Monte-Carlo over historical throughput/velocity distribution → date + p50/p85 confidence band. **Window:** point-in-time. **Scopes:** sprint, epic, release. **Source:** `forecast` (BC-10), throughput history.
- **Notes:** always presented as a **range with confidence**, never a false-precision single date.

### forecast_accuracy
- **Definition:** model calibration — predicted vs actual.
- **Formula:** `1 − |predicted_date − actual_date| / horizon`, aggregated. **Window:** trailing completed targets. **Scopes:** team, org. **Source:** `forecast` vs realized. **Notes:** drives trust in predictions; surfaced to admins.

---

## 7. People & Collaboration *(ethics-bound; team-level default)*

> All metrics in this section default to team/aggregate scope, are RBAC-gated for any individual view, and are framed for support — never ranking. See [security/AUTH-AND-RBAC.md §5](../security/AUTH-AND-RBAC.md).

### collaboration_index
- **Formula:** breadth of distinct co-review/co-commit partners per developer/team, normalized. **Scopes:** team, developer* (self/manager). **Source:** `collaboration_edge`.

### knowledge_concentration / bus_factor
- **Definition:** risk that knowledge of a module sits with too few people.
- **Formula:** bus_factor = min number of developers owning ≥50% of a module's changes; concentration = top-owner share. **Scopes:** repo, path, team. **Source:** `code_ownership`.
- **Notes:** a key Architecture-risk input; **module-level, not a person score**.

### onboarding_ramp
- **Formula:** `time_to_first_merged_PR` and `time_to_first_linked_story_done` for new joiners. **Scopes:** team, developer* (supportive). **Source:** `pull_request`, `story`, join date.

### workload_balance
- **Formula:** dispersion (coefficient of variation) of active WIP / review load across team members. **Scopes:** team. **Source:** `wip`, `reviewer_load`.

### burnout_risk_signal
- **Definition:** sustained overload pattern — **supportive flag, team-level**.
- **Formula:** rolling pattern of (after-hours activity share AND sustained over-WIP AND high review load) above thresholds. **Window:** rolling 30d. **Scopes:** team (individual only to the person + their manager, gated).
- **Source:** `commit`/`pr_review` timestamps, `wip`. **Notes:** explicitly *not* a performance metric; designed against misuse.

---

## 8. Composite Scores (0–100, explainable)

All composites are **weighted, normalized blends** of section metrics. Every `composite_score` row stores `components` (each input's normalized value + weight + raw), so the score always drills to *why*. Weights below are **defaults**, tenant-overridable. Normalization maps each input to 0–100 via tenant baseline or sensible target bands; missing/low-coverage inputs reduce the score's `confidence`, not silently the value.

| Score | Inputs (default weights) | Scope |
|---|---|---|
| **sprint_health** | commitment_reliability 35 · scope_creep(inv) 20 · flow_efficiency 20 · blocked_time(inv) 15 · aging_items(inv) 10 | sprint/team |
| **repository_health** | review_coverage 25 · churn(inv) 20 · activity 15 · hygiene(stale branches/self-merge, inv) 20 · ownership/bus_factor(inv) 20 | repo |
| **engineering_health (org)** | flow (cycle/flow_eff) 30 · quality_score 25 · reliability(DORA) 25 · people(balance/bus_factor) 20 | org/team |
| **risk_score** | Σ open `rule_finding` weighted by severity × recency (higher = worse; presented inverted where "health" framing applies) | any scope |
| **quality_score** | coverage 30 · defect_density(inv) 25 · quality_gate_pass 20 · debt_ratio(inv) 15 · duplication(inv) 10 | repo/project |
| **review_score** | coverage 30 · depth(inv rubber-stamp) 25 · latency(inv) 25 · distribution(inv concentration) 20 | repo/team |
| **release_confidence** | test coverage of changed code 30 · change_risk(inv) 25 · open critical vulns(inv) 20 · recent change_failure_rate(inv) 15 · hotspot involvement(inv) 10 | release |
| **innovation_score** | share of new-capability work vs maintenance/bug/debt (investment mix) 100 | team/org |
| **productivity_score** | flow-efficiency-weighted throughput 60 · predictability 25 · quality guardrail(inv defects) 15 — **explicitly excludes LOC/commit count** | team only |
| **predictability_score** | forecast_accuracy 50 · commitment_reliability 50 | team/org |
| **collaboration_score** | collaboration_index 50 · review distribution 30 · bus_factor(inv) 20 | team |

> **Hard rule:** `productivity_score` and all composites are **team-level**; none may be derived from or presented as an individual ranking, and none may use LOC/commit-count as a positive contributor.

---

## 9. Computation, freshness & lineage

- **Incremental on event:** affected metric_values recompute when relevant domain events arrive (PR merged, story transitioned, deploy finished).
- **Scheduled rollups:** the Scheduler (M17) recomputes aggregates, percentiles, composites, and forecasts on cadence (e.g., hourly aggregates, per-sprint-close finalization).
- **Freshness:** `metric_health.data_freshness` reflects the newest contributing event; stale beyond threshold → shown as stale.
- **Lineage:** each value links to its source events/correlation links (`lineage_link`) so every dashboard number is traceable (architecture guarantee).
- **Coverage floors:** correlated metrics (anything depending on linkage) carry `linkage_coverage`; below the per-metric floor they render as "low confidence."

## 10. Change policy

Adding or changing a metric: update this catalog (definition + formula + window + scopes + source), register it in `metric_definition`, ensure lineage + metric_health, add tests (including tenant isolation), and align dashboards/rules/agents that consume it. Any metric exposed to the UI also registers a widget spec in the frontend widget registry ([DASHBOARDS.md §5](DASHBOARDS.md)). Ethics review required for any new individual-scope or people metric.
