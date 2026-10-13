# ADR-0010: Discover branch-only commits from the GitHub org audit log

- **Status:** Accepted — Phase 1 implemented 2026-10-06 (shadow mode first)
- **Date:** 2026-10-06
- **Deciders:** Product owner, engineering
- **Related:** [ADR-0008](0008-github-graphql-over-webhooks.md), [ADR-0009](0009-attributed-commit-digest.md), [api/README.md §3, §12 #51](../api/README.md), [design spec](../superpowers/specs/2026-10-06-github-audit-log-commit-discovery-design.md), [handover](../superpowers/specs/2026-09-29-commit-completeness-handover.md)

## Context

Commits reached `code_commit` by two routes: the default-branch walk and the PR commit harvest. A commit pushed to a non-default branch and never in a PR was invisible to both (gap #51). On 25 Sep 2026 the daily digest (ADR-0009) named at least 6 of 27 developers who had committed that day. The handover proposed a git mirror. Before building infrastructure, the cheaper option was to use GitHub's own record of every push: the Organization Audit Log.

Verified on 2026-10-06:
- `git.push` entries carry **no ref and no before/after SHA**. They give the repo, actor, `@timestamp` and `_document_id`.
- Git events are kept **7 days**, are REST-only, and **exclude pushes made through the web UI or API**.
- The audit log needs an org-owner token with `read:audit_log`. The collector token is refused. It has its own 1,750/h bucket.
- `git/matching-refs/heads/` returns every branch tip of a repo in one call (`ehr`: 1,474).

## Decision

Add a third discovery route inside BC-1 that feeds the existing ingestion pipeline:

1. **Detect.** Every `GITHUB_AUDIT_SYNC_INTERVAL_MINUTES` (default 5; 5/10/15/20/30/60), read `git.push` events since `checkpoint − overlap`, following `Link rel="next"` verbatim until it is absent. Only a complete window is used.
2. **Record.** Each push becomes a raw `code.push.observed` event (`github:audit:{_document_id}`). This is lineage that outlives GitHub's retention.
3. **Plan.** For each registered repo pushed to, diff current branch tips against the tips stored last run. Each moved ref yields one Compare `old...new`. A new ref compares against the default branch. A deleted ref is recorded only. This is the consolidated range: N pushes to one ref cost one Compare.
4. **Queue, then checkpoint.** Ranges are persisted (`collectors_github_push_range`) before the checkpoint advances.
5. **Fetch.** Compare is consumed to its last page with bounded concurrency, under a run-level `core` rate-budget estimate (latest remaining minus `GITHUB_BACKFILL_RATE_RESERVE`, decremented per Compare page and per commit-detail call); exhausting it stops execution for the run and leaves the remaining ranges `pending`. For commits not already collected, line stats come from `GET /commits/{sha}`. A commit whose detail call fails for a reason other than rate-limiting (no stats returned) is never ingested without them — the range's attempt fails and is retried, rather than ingesting a commit permanently missing its line-change stats. Commits are ingested with the same envelope and `github:{repo}:commit:{sha}` key as every other route; a commit reachable from more than one range in the same run is resolved once, not once per range.
6. **Modes.** `off` (default) | `shadow` (counts `wouldIngest`, writes no commit) | `ingest` (also replays `shadowed` ranges from the last 7 days).

`pending` ranges — queued but not yet successfully executed — are retried every run with no age cutoff, until they succeed or exhaust `GITHUB_AUDIT_MAX_RANGE_ATTEMPTS` (then `failed`). Only `shadowed` ranges (completed in shadow mode) are subject to the 7-day replay window when a tenant switches to `ingest`.

The existing walk and PR harvest are unchanged and keep running.

## Consequences

- Branch-only commits are collected for every push observed after the one-off **seeding pass**. Nothing before seeding is recovered by this route.
- **Known blind spots, documented rather than hidden:** web/API pushes (F6); refs created and deleted, or history force-pushed away, between two runs; Compare's 250-commit cap (flagged as `truncated`); outages longer than 7 days. Push lineage is per repo, not per ref.
- **Retention is a run-level signal, not a per-range one.** A run compares `now` against the checkpoint as it stood *before* that run (so a successful run from a stale checkpoint is still flagged): past 6 days of age the run is reported and logged at error level as a retention risk; past 7 days the message states the gap is unrecoverable from the audit log. The checkpoint still advances on a successful run regardless.
- **Historical figures move** once ingest is enabled. That is a restatement, and it must be announced.
- If a tenant's registered repos cannot even be loaded, the run reports `failed` and no run row is created for it — there is nothing yet to report counters against.
- New secret: an org-owner token, used only for the audit call. New tables: 4 (DATA-MODEL.md). Expected `core` spend is two calls per active repo once for seeding (default branch + branch tips), then one `matching-refs` call per touched repo plus one Compare per moved ref plus one detail call per new commit. All of it is charged against one run-level budget (remaining − `GITHUB_BACKFILL_RATE_RESERVE`) checked before each seeding repo, listing, and detail call, so a run stops at the reserve (in-flight concurrent calls can overrun it by at most the Compare concurrency) and resumes next run.
- The digest's gate 1 is unchanged. `dailyDigestEnabled` stays off until acceptance (spec §9) passes.

## Alternatives considered

- **Compare per audit event:** impossible, because the events carry no SHAs.
- **Events API `PushEvent`:** carries `before`/`head` but is per repo, capped at 300 events and lossy on busy repos. It is used only to build acceptance ground truth.
- **Webhooks:** deferred (ADR-0008).
- **Git mirror (Phase 2):** a complete enumeration of refs, but it needs `git`, disk and a fleet clone. Build it if acceptance or operation shows unexplained misses, misses from refs deleted or force-pushed between runs, a retention overrun, or tip-diff `core` spend that threatens the collectors.

## 2026-10-12 update — completeness hardening

Five changes, agreed in conversation against gaps found running the route (plan: [docs/superpowers/plans/2026-10-12-audit-sync-completeness-hardening.md](../superpowers/plans/2026-10-12-audit-sync-completeness-hardening.md)):

1. **Org-wide refusal guard.** A seeding pass that seeds zero repos, or where at least half the attempted repos come back refused (403 *or* 404 — an org-wide access loss typically shows up as 404 on every repo, not 403), is reported `failed`, never `seeded`: `seededAt`/`checkpointAt` are left unset so a refused token can never seed the checkpoint as if the org had actually been observed. `run.error` names the cause (`collector token refused (403/404) for N of M repos — check token scope, SSO authorization and that these repos still exist`). A pass with zero refusals and only transient failures still reports `partial` and retries next run; a lone 404 among otherwise-successful repos is a named unseedable skip, not a refusal.
2. **Lag visibility.** New `GITHUB_AUDIT_LAG_WARN_MINUTES` (default 30, range 5–1440; the effective threshold is never less than two audit intervals, `max(threshold, 2 × GITHUB_AUDIT_SYNC_INTERVAL_MINUTES)`, so a 60-minute interval does not warn on every run), measured against the checkpoint as it stood *before* the run (so a cron that silently stopped firing still reports lag, rather than a successful run always reading as fresh). Over the threshold, the run logs a warning and prefixes it to `run.error`. New read-only `GithubAuditSyncService.status(tenantId)` answers "is the route trustworthy right now" independent of any run in flight — `mode`, `enabled`, `seededAt`, `checkpointAt`, `lagMinutes`, `behind`, `lastRunAt`/`lastStatus`/`lastError`, `pendingRanges`, `failedRanges`, `lastFullSweep` — exposed as `GET /admin/configurations/github/audit-sync/status` (ADMIN).
3. **Full branch sweep.** The audit log's exclusion of web/API pushes (Consequences, above) previously meant such a push was caught only when a *later* `git push` to the same repo moved a tip the next audit run happened to see — an unbounded delay. A new cron, `GithubAuditSchedulerService.sweepTick` (`GITHUB_AUDIT_FULL_SWEEP_MINUTES`, default 60; allowed `0`/`30`/`60`/`120`/`240`, `0` = off), lists every registered repo's branches on its own cadence and plans ranges from the tip diff exactly as discovery does, with no audit evidence attached (run rows get `trigger: 'full_sweep'`; existing audit runs are `trigger: 'audit'`). It shares the per-tenant run claim with the audit cron — the two never plan or execute concurrently — waits until the tenant's audit seeding has completed, and never reads the audit log or moves `checkpointAt`/`seededAt`: the checkpoint still answers only for what the audit log itself covered.
4. **Auto-registration.** A push to a repo with no GitHub connection at all in the tenant (any status) is registered exactly as the admin org sync would (`name`/`config.repoFullName`/`secretRef`/`backfillSince`), seeded, and — only when it has at most `GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES` branches (default 50, range 0–500) — given a `new_ref` range per non-default branch, so the push that revealed the repo is collected now instead of waiting for the next org sync; above the cap it is seeded only, noted in `run.error`. An existing connection of any status (including disabled) is left alone — reactivating it is an admin decision, unlike the admin org sync. Archived, disabled, 404 and 403 repos are skipped and counted. Shadow mode only reports what it *would* register (`reposWouldRegister`) and creates nothing — consistent with shadow never writing anything the ingest-mode route would.
5. **Digest gate.** New read-only `coverageForDay(tenantId, day)` lets the daily digest (ADR-0009) ask "has the audit route actually covered this day," distinct from gate 1's "is the pipeline alive" (gate 1 is unchanged). It `applies` only when the tenant runs the route in `ingest` mode with an audit-log token ref configured. When it applies and cannot vouch for the day — the checkpoint hasn't reached day-end-IST plus the overlap, an unresolved (`pending`/`failed`) push range was created on or after the day began with **no upper bound**, or (when the sweep is enabled) no successful sweep has *started* after the day ended — `NoCommitDetectionService` withholds names (`withheld_stale_data`), evaluated directly after gate 1. The check fails closed: an error evaluating coverage also withholds. Ethics-first throughout: a gap only ever withholds names, it never adds them.

**Consequences, added:**

- Web/API pushes are now caught within one full-sweep interval (`GITHUB_AUDIT_FULL_SWEEP_MINUTES`, default one hour) of landing, rather than being left to a lucky later push or to the 7-day retention window (#58).
- **New operator duty: a `failed` push range withholds the digest indefinitely until an admin resolves it.** The coverage check's unfinished-range condition has no upper bound by design — a late-discovered gap must keep withholding the day it affects, however long after the fact it surfaces — so once a range exhausts `GITHUB_AUDIT_MAX_RANGE_ATTEMPTS` and lands in `failed`, every later day's digest stays withheld (so long as the gate's other conditions are otherwise met) until an admin inspects and resolves it, whether by re-running the sync so the range retries, or by accepting the gap. The admin `GET .../audit-sync/status` endpoint's `failedRanges`/`pendingRanges` counts and `lagMinutes`/`behind` are how an operator is meant to notice before the digest does.
- The refusal guard and the lag/status surface make a refused token or a stalled cron visible within minutes, rather than silently via a withheld digest days later.
- `tsconfig.build.json` now excludes `**/*.fakes.ts` — a test helper that was being compiled into the production build.
