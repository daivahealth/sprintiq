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
- New secret: an org-owner token, used only for the audit call. New tables: 4 (DATA-MODEL.md). Expected `core` spend is one `matching-refs` call per touched repo plus one Compare per moved ref plus one detail call per new commit, all under the rate reserve.
- The digest's gate 1 is unchanged. `dailyDigestEnabled` stays off until acceptance (spec §9) passes.

## Alternatives considered

- **Compare per audit event:** impossible, because the events carry no SHAs.
- **Events API `PushEvent`:** carries `before`/`head` but is per repo, capped at 300 events and lossy on busy repos. It is used only to build acceptance ground truth.
- **Webhooks:** deferred (ADR-0008).
- **Git mirror (Phase 2):** a complete enumeration of refs, but it needs `git`, disk and a fleet clone. Build it if acceptance or operation shows unexplained misses, misses from refs deleted or force-pushed between runs, a retention overrun, or tip-diff `core` spend that threatens the collectors.
