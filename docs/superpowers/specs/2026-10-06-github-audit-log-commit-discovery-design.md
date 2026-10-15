# Design: GitHub Audit Log push discovery + Compare commit retrieval (Phase 1)

**Date:** 2026-10-06
**Status:** Design agreed in brainstorming; awaiting spec review before the implementation plan.
**Supersedes for Phase 1:** the git-mirror direction in `2026-09-29-commit-completeness-handover.md` §3 (the mirror stays the Phase 2 fallback, §11).
**Branch:** `feat/github-audit-commit-discovery`, based on PR #39 (`fix/pr-commit-truncation`, open).

---

## 1. Problem

The daily digest names tracked developers with no delivery activity on the previous IST working day (ADR-0009). Commit collection reaches `code_commit` by two routes only: the default-branch walk and the PR commit harvest. A commit pushed to a non-default branch that is in no PR is invisible to both (handover cause B, gap #51 "still open"). On 25 Sep 2026 at least 6 of 27 named people had committed that day.

Phase 1 adds a third discovery route. It detects pushes org-wide from the GitHub Organization Audit Log, then retrieves the commits through the Compare API, and feeds them into the **existing** ingestion pipeline under the **existing** idempotency key. The existing collectors keep running unchanged.

## 2. Verified facts this design rests on

Verified 2026-10-06 against `athmahealth` unless marked as documentation.

| # | Fact | Evidence |
|---|---|---|
| F1 | `GET /orgs/{org}/audit-log?include=git&phrase=action:git.push created:>=…&order=desc&per_page=100` returns `git.push` entries. | Live probe, 200 OK. |
| F2 | **A `git.push` entry carries no ref and no before/after SHA.** It has `@timestamp` (epoch ms), `_document_id`, `action`, `actor`, `repo`/`repository`, `external_identity_username`, `programmatic_access_type`, `transport_protocol(_name)`, `org`, `org_id`, `business`, `external_id`, `repository_public`, `user`, `user_id`, plus network/token fields (`actor_location`, `hashed_token`, `token_id`, `user_agent`) that are **never stored or logged**. | Live probe, 3 entries; consistent with the documented field list. |
| F3 | Pagination is cursor-based. The `Link` next URL is **rewritten** by GitHub to `/organizations/{org_id}/audit-log?…&after=…&before=…`. | Live probe. Follow it verbatim; never rebuild. |
| F4 | The app `GITHUB_TOKEN` is refused (`403 Resource not accessible by personal access token`). The audit log needs an org-owner classic PAT with `read:audit_log`, SSO-authorized. The working token reports scopes `audit_log, repo`. | Live probes. |
| F5 | The audit log has its **own rate bucket**: `X-RateLimit-Resource: audit_log`, limit **1,750/h**, independent of `core` (5,000) and GraphQL. | Live headers. |
| F6 | Git events are retained **7 days** and are available via REST only. Pushes made through the web UI or REST/GraphQL API (e.g. a PR merged in the browser, a web-editor commit) are **not** included. | GitHub docs (Enterprise Cloud audit log). |
| F7 | `GET /repos/{r}/git/matching-refs/heads/` returns **all** branch tips in one response, with no `Link` header (`ehr`: 1,474 refs, 760 KB, 3.3 s, 1 `core` request). | Live probe. |
| F8 | The existing REST client treats every 403 as a rate limit (`github.client.ts` `getPage`). A permission or SSO 403 on the audit call would be misreported. | Code read. |
| F9 | Ingestion drops a duplicate key **before** the projector (`ingestion.service.ts`), and the projector upserts every field (`code.service.ts` `handleCommit`). The first envelope for a SHA therefore decides that row's fields for good, apart from the manual stats reconciler. | Code read. |
| F10 | Compare (`GET /repos/{r}/compare/{base}...{head}`) returns commits reachable from `head` and not from `base`, including on `diverged` histories, and returns at most 250 commits per comparison even across pages. Per-commit line stats are absent. | GitHub docs. Re-verified in implementation task 1. |

Because of F2, the brief's "chain `before → after` per audit event" cannot be built from the audit log alone. The ref and SHA range come from **branch-tip diffing** (§4.3) instead. The brief's goals still hold: complete audit pagination before planning, grouping by repo + ref, one Compare request per moved ref (the consolidated range), bounded concurrency, and preserved lineage.

## 3. Decisions (taken in brainstorming)

| Decision | Choice |
|---|---|
| Audit credential | New secret ref `auditLogTokenRef` in the GitHub configuration, used **only** for the audit-log call. Compare, refs and commit-detail calls use the existing collector token. |
| No ref/SHAs in entries (F2) | **Branch-tip diff** for repos the audit log says were pushed to. |
| Line stats | Fetch `GET /commits/{sha}` **only** for commits whose idempotency key is not yet in `collectors_raw_event`. |
| Acceptance day | A fresh working day inside the 7-day retention window, checked against independent ground truth. 25 Sep becomes a fixture test (the live events expired around 2 Oct). |
| Mirror | Not built. Documented as Phase 2 with explicit trigger criteria (§11). |

## 4. Architecture

All new code lives in the Collector context (BC-1, `backend/src/collectors/`). It is the only place that talks to GitHub.

```
Cron every N min (env) ─► running guard (SchedulerTick 'github-audit')
  for each tenant with GitHub configured + auditLogTokenRef resolvable:
  0  first enable: seeding pass (store tips of every active repo; no Compare)
  1  window  = [checkpoint − overlap, runStartedAt]   (first window starts at seeding)
  2  AUDIT   : fetch page 1, follow Link rel="next" verbatim until absent.
               Any page fails ⇒ run fails, checkpoint unchanged, nothing planned.
  3  DEDUPE  : by _document_id (within run). Store each push as raw event
               code.push.observed, key github:audit:{_document_id} (dup across runs = no-op).
  4  PLAN    : touched repos = distinct repo of the pushes ∩ repos with a Connection.
               Per touched repo: matching-refs/heads (1 call) → tips now;
               diff against stored GithubRefTip rows → one PushRange per moved ref.
  5  PERSIST : PushRange rows (pending) + new GithubRefTip values, in one transaction;
               then checkpoint := runStartedAt.
  6  EXECUTE : pending ranges (this run's and earlier retries), bounded concurrency:
               Compare base...head, Link-paged to the end → commits;
               per commit: raw key exists? alreadyPresent : (detail → ingest).
               Range → done | pending (attempts++) | failed (attempts ≥ max).
  7  REPORT  : GithubAuditRun row with counters; structured log line.
```

### 4.1 Audit request construction

`https://api.github.com/orgs/{organization}/audit-log` with:

- `include=git`
- `phrase=action:git.push created:>={windowFrom ISO-8601 UTC}`
- `order=desc`
- `per_page={GITHUB_AUDIT_PAGE_SIZE, default 100}`

`organization` comes from the tenant's `github` TenantConfiguration `values.organization`. Nothing is hard-coded. Encoding matches the verified request (`%20`, `%3E`, `%2B`).

### 4.2 Pagination contract (both flows)

- Parse the `Link` header. While `rel="next"` is present, request **that exact URL**. Assert that its origin is `https://api.github.com` before sending the token. Never compute page numbers or cursors.
- The set is complete only when a page returns with no `rel="next"`.
- A non-2xx on any page aborts the flow. The result is `failed`, never a partial list.
- A **rate-limit** response (403/429 with `x-ratelimit-remaining: 0` or `retry-after`) is distinguished from a **permission/SSO** 403 (anything else). The first reports `rateLimitedUntil`; the second reports `forbidden` with a remediation message naming the scope and SSO requirement (F8).
- A page-count safety ceiling (`GITHUB_AUDIT_MAX_PAGES`, default 200 = 20,000 pushes) exists only to stop a runaway loop. Hitting it is a **failure**, never a silent stop.

### 4.3 Branch-tip diff (plan)

For each touched repo, call `matching-refs/heads/` once and compare against `GithubRefTip` (tenant, repo, ref → sha):

| Stored | Now | Range | Kind |
|---|---|---|---|
| sha A | sha B (≠ A) | Compare `A...B` | `moved` (fast-forward or force-push; Compare handles both, F10) |
| none | sha B | Compare `{defaultBranch}...B` | `new_ref`: the commits on the branch not yet on the default branch |
| sha A | absent | none | `deleted`: record only. Its commits were captured when the tip was last seen, or are unrecoverable (§10). |
| sha A | sha A | none | unchanged: the push went to a ref deleted again, or the tip did not move |
| default branch | moved | Compare `A...B` | normal. The API walk also covers it; the key converges. |

- **First sight of a repo** (no stored tips at all) is **seed-only**: all its tips are stored and no Compare runs. `matching-refs` carries no dates, so there is no cheap way to tell which of `ehr`'s 1,474 branches moved recently. Comparing them all would cost about 1,474 calls for one repo. To keep that gap to one moment, enabling the sync (any mode other than `off`) first runs a **seeding pass** over every active GitHub connection: one `matching-refs` call each, about 198 calls total, paced through the bounded executor. Audit discovery therefore covers pushes **from seeding onward**. History before it stays with the existing routes and the PR backfill. A repo whose first audit push arrives before it was seeded (e.g. a connection registered later) is seeded on that run and counted in `reposSeeded`. Commits from that one push are left to the existing routes; this is listed in §10.
- `defaultBranch` is read from the repo's connection config if present. Otherwise one `GET /repos/{r}` call per repo, cached in `GithubRefTip` as a `HEAD` marker row.
- The audit pushes for a repo are attached to every range planned for it in that run (`auditDocumentIds`). The audit log does not say which ref a push hit (F2), so lineage is per repo+run. This is stated, not hidden.
- **API-call measure:** `compareCandidatesNaive` = unique pushes (one Compare per push, per the brief's baseline). `compareRequestsPlanned` = moved refs. Both are reported.

### 4.4 Execute

- Concurrency: `forEachBounded` (extracted from `collector-scheduler.service.ts` into `common/concurrency.ts`), default 2. There is never an unbounded `Promise.all`.
- The rate reserve (`evaluateBudget`, `GITHUB_BACKFILL_RATE_RESERVE`) is honoured on the `core` bucket. Reaching it stops execution for this run, and the remaining ranges stay `pending`.
- Compare pages are followed per §4.2. If `total_commits` > commits returned (the 250 cap), the range is `truncated=true` and reported. It is never claimed complete.
- Per commit, a `rawEvent.findUnique(tenantId, github:{repo}:commit:{sha})` lookup in the collector's own table runs first. A hit counts as `alreadyPresent`, with no detail call. A miss in **ingest** mode calls `getCommitDetail` (stats + committer date), then `ingestion.ingest`. A miss in **shadow** mode counts as `wouldIngest` (no detail, no ingest).
- The envelope is built by the **same** builder the collector and the PR backfill use, extracted to `github-commit-envelope.ts`: same `eventType`, key and payload shape. It adds `externalRefs.ref`, `externalRefs.discoveredBy='github-audit-compare'` and `externalRefs.pushRangeId`, and `data.parentCount` (merge-commit data for a later decision; no behaviour change).

### 4.5 Checkpoint and failure semantics

- The checkpoint advances only after step 5 commits, meaning the complete audit set has been fetched and its work is durably queued. Failure in steps 2–5 leaves it unchanged, and the next run re-reads the window.
- A failure in step 6 never touches the checkpoint. The range stays `pending` and is retried next run, up to `GITHUB_AUDIT_MAX_RANGE_ATTEMPTS` (default 5), then becomes `failed`. Failed ranges are reported, never auto-retired as done.
- **Retention guard:** if `now − checkpoint > 6 days`, the run is reported `retention_risk`, logged at error level, and shown on the report. Past 7 days the gap is unrecoverable from the audit log, and the report says so.
- Every replay path is idempotent: `_document_id` raw keys, tip diffs against stored state, and commit keys.

### 4.6 Identity

There is no new identity logic. The payload carries `authorLogin` (Compare `author.login`), `authorName` and `authorEmail`, exactly as `fromPolledCommit` does. Attribution stays with `DeveloperIdentityService.resolveTenant` / `attributionIndex`. An email-only author stays **unattributed**, never idle; the digest already discloses `unattributedCommits`. The audit `actor` is the pusher, **not** the author, and is never used for attribution; it is kept in the raw push event only. Bots, excluded identities and untracked developers are handled downstream exactly as today, because this path only adds `code_commit` rows.

### 4.7 Modes and configuration

| Env var | Default | Validation |
|---|---|---|
| `GITHUB_AUDIT_SYNC_MODE` | `off` | `off` \| `shadow` \| `ingest`; anything else fails boot |
| `GITHUB_AUDIT_SYNC_INTERVAL_MINUTES` | `5` | one of 5, 10, 15, 20, 30, 60; the cron is built at module load (pattern: `DAY_CLOSE_HOUR_IST`) |
| `GITHUB_AUDIT_PAGE_SIZE` | `100` | 1–100 |
| `GITHUB_AUDIT_OVERLAP_MINUTES` | `15` | 0–120 |
| `GITHUB_AUDIT_COMPARE_CONCURRENCY` | `2` | 1–8 |
| `GITHUB_AUDIT_MAX_RANGE_ATTEMPTS` | `5` | 1–20 |
| `GITHUB_AUDIT_MAX_PAGES` | `200` | 1–1000 |

All values are parsed in one module (`github-audit.config.ts`) and boot-validated in `env.validation.ts`. The token is resolved via `SecretsService` from `auditLogTokenRef` (DB store, then env fallback such as `GITHUB_AUDIT_TOKEN`). Tenants without the ref are skipped with a logged reason.

## 5. Data model (one migration, applied by hand on the host)

All models are tenant-scoped, prefixed `collectors_github_` (BC-1), and have no FKs into other contexts.

- **`GithubAuditCheckpoint`**: `tenantId` @unique, `organization`, `checkpointAt`, `lastRunAt`, `lastStatus`, `lastError`.
- **`GithubAuditRun`**: `id`, `tenantId`, `mode`, `startedAt`, `finishedAt`, `windowFrom`, `windowTo`, `status` (`running|success|partial|failed`), `counters` Json (§7), `error`. Index `(tenantId, startedAt)`.
- **`GithubPushRange`**: `id`, `tenantId`, `runId`, `repoFullName`, `ref`, `baseSha?`, `headSha?`, `kind` (`moved|new_ref|deleted`), `auditDocumentIds` Json, `status` (`pending|done|failed`), `attempts`, `commitsFound`, `alreadyPresent`, `ingested`, `truncated`, `lastError`, `createdAt`, `updatedAt`. Indexes `(tenantId, status)`, `(tenantId, createdAt)`.
- **`GithubRefTip`**: `tenantId`, `repoFullName`, `ref`, `sha`, `seenAt`; unique `(tenantId, repoFullName, ref)`.

Raw audit pushes reuse `collectors_raw_event` (event type `code.push.observed`, connection = the repo's Connection). No second event store is added. Stored fields: `_document_id`, `@timestamp`, `actor`, `repo`, `external_identity_username`, `programmatic_access_type`, `transport_protocol_name`. Network/token fields are dropped at parse time.

## 6. Admin surface

- `POST /admin/configurations/github/audit-sync/run`: run once now for the caller's tenant (admin role, audit-logged). Returns the run counters.
- `GET /admin/configurations/github/audit-commit-report?day=YYYY-MM-DD`: an IST-day report (§7) aggregated from runs, ranges and raw events for that day.

There is no frontend change in Phase 1.

## 7. Report and observability

Per run (logged in one structured line and stored in `counters`), and per IST day:

`reposSeeded`, `auditPages`, `auditNextTraversals`, `auditEvents`, `uniquePushes`, `reposTouched`, `reposUnregistered`, `refsMoved`, `refsNew`, `refsDeleted`, `compareCandidatesNaive`, `compareRequestsPlanned`, `compareRequestsSaved`, `comparePages`, `commitsDiscovered`, `alreadyPresent`, `ingested` / `wouldIngest`, `unattributed` (no login, and email not in the identity index at report time), `truncatedRanges`, `failedRanges`, `pendingRanges`, `checkpointAt`, `durationMs`, `rateLimit` {audit_log, core remaining}.

Logs never contain the token, the Authorization header, or `after`/`before` cursors; URLs are logged with the query string stripped.

## 8. Testing

Jest, colocated `*.spec.ts`; the GitHub clients are mocked at the `fetch` boundary as the existing client specs do.

- **Planner (pure):** dedupe by `_document_id`; grouping by repo; tip diff covering moved, new, deleted, unchanged, first-sight seeding and default branch; multiple refs in one repo; multiple repos; naive vs planned counts.
- **Audit client:** URL construction (`per_page=100`, phrase, encoding); one page; multiple pages via `rel="next"` followed verbatim; no next; a page-3 failure yields `failed` with no partial list; permission-403 vs rate-limit-403; the origin assertion; the max-pages ceiling fails.
- **Compare client:** multi-page; `diverged`; truncation flag; 404 on a vanished base.
- **Sync service:** checkpoint not advanced on audit failure; advanced after persist; Compare failure leaves the range pending and the checkpoint advanced; attempts cap yields failed; rate reserve stops execution; overlap re-read ingests nothing new; duplicate SHA across ranges; a raw key already present gives no detail call (existing-collector duplicate); shadow mode writes no commit envelopes; ingest failure; tenant isolation (two tenants, separate checkpoints, tips, ranges and tokens, no cross-read).
- **Config:** default interval 5; 10/15/30/60 map to the right cron; an invalid value fails boot; mode validation.
- **Fixture:** 25 Sep 2026: `ehr` branch `ACT-92441-aot-induction` with `0defa5a6e4`, `50b124b05b`, no PR. The tip diff yields a range, Compare yields both commits, both are ingested with lineage, and a second run ingests 0.

Verification gates: `npx tsc --noEmit`; `npx eslint <files> | grep -v 'Delete \`␍\`'` with zero errors; the jest suite; `rm -rf dist && nest build`.

## 9. Acceptance (live, host)

1. Deploy in **shadow** mode (this runs the seeding pass), then pick the first full working day D after seeding.
2. Build ground truth independently, using the handover §9 method: Events API `PushEvent`s → `compare` per push → resolve logins, restricted to non-default branches.
3. Every ground-truth commit appears as `alreadyPresent` or `wouldIngest` for D. Each miss is classified as web push (F6), a deleted or force-pushed ref between runs, the 250 cap, or a defect.
4. `compareRequestsPlanned` is materially below `compareCandidatesNaive`.
5. GraphQL `rateLimit.remaining` and complexity-fallback warnings are not materially worse; `core` spend is within the reserve.
6. Switch to **ingest**. Run twice; the second run ingests 0. Re-run the digest dry run for D and confirm parity (roster − Overview-active = flagged).
7. Several consecutive shadow/ingest days with zero unexplained misses come **before** anyone considers re-arming `dailyDigestEnabled`, which stays `false` throughout.

## 10. Known limitations (documented, not hidden)

- **Web/API pushes** are absent from git events (F6). A web-editor commit to a branch is caught only if a later git push touches the same repo (the tip diff then sees the moved ref). PR merges are covered by the existing routes.
- A **ref created and deleted between two runs**, or **history force-pushed away between runs**, is unrecoverable: its commits never appear at any observed tip.
- The **7-day retention** caps recovery after an outage.
- **No backfill before seeding.** Audit discovery starts at the seeding pass. A repo first seen through an audit push (not seeded beforehand) leaves that one push to the existing routes.
- The **Compare 250-commit cap** applies per range; truncated ranges are flagged.
- **Push lineage is per repo**, not per ref (F2).
- `committedAt` windowing and merge-commit counting are unchanged. Phase 1 adds rows; it does not redefine activity.
- **Historical figures move** when ingest is enabled: branch-only commits appear for days already shown. Announce this; don't ship it quietly (gap #51).

## 11. Phase 2 (git mirror): trigger criteria

Revisit the mirror from the handover §3 if, during acceptance or in operation, any of these are measured: unexplained ground-truth misses; misses from deleted or force-pushed refs between runs at a rate that matters to the digest; a retention overrun; or `core` spend from the tip diff and Compare that threatens the collectors. No mirror code exists in Phase 1.

## 12. Product questions for the owner (defaults in force until answered)

1. Is 5-minute polling sufficient? (Default 5; the audit bucket allows about 1,750/h.)
2. Overlap: default 15 min.
3. Backfill horizon: from go-live (the seeding pass). Earlier history stays with the existing routes; a retroactive pass would need per-branch date lookups (cost: about one call per branch).
4. Late-arriving commits restate history, as today.
5. Merge commits stay counted (`parentCount` is now recorded).
6. Activity date stays `committedAt`.
7. Incomplete audit collection: the run or range is reported, and the digest stays off.
8. The digest can trust the new collector only after §9 step 7.
9. Raw push events are retained like other raw events.
10. Mirror fallback criteria: §11.

## 13. Documentation changes (same change set)

- `docs/ADR/0010-github-audit-log-commit-discovery.md` + the ADR index.
- `docs/architecture/PRODUCT-ARCHITECTURE.md` (BC-1 flow) and `DATA-MODEL.md` (4 tables).
- `docs/api/README.md`: §3 bullet (third commit source), §9 (two endpoints), gap #51 (branch-only commits now addressed by audit discovery, with limitations), and new gap rows for web pushes, retention and the Compare cap.
- `docs/deployment/README.md` §5: env vars, the audit token (classic PAT, `read:audit_log`, org owner, SSO), the migration, the shadow → ingest rollout, and rollback (mode `off`; ingested commits remain).
- `docs/features/NOTIFICATIONS.md`: a note that gate 1 is unchanged and the digest stays off until §9 step 7.
- `backend/.env.example`: the new variables (values blank).
