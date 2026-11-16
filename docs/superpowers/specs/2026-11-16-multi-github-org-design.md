# Multiple GitHub organisations per tenant — design

Date: 2026-11-16 · Status: approved in brainstorming, pending spec review

## 1. Goal

A tenant can collect from more than one GitHub organisation (first case:
`NHWebsite` beside `athmahealth`). **Adding an organisation must not change
the behaviour of any organisation already configured** — its connections,
audit-log checkpoint, swept repos, refusal guard, rate budget and Copilot sync
stay exactly as they were.

The one deliberate cross-org effect is the daily commit digest, which becomes a
single combined digest across all included organisations (§6).

## 2. Current state (verified 2026-11-16)

- GitHub config is one `TenantConfiguration` row, `github/default`, with one
  `organization`. The table already allows many rows per namespace
  (`@@unique([tenantId, namespace, key])`).
- Five org-wide features read only `github/default`: org sync (button +
  `GithubOrgSyncSchedulerService`), the audit-log route
  (`GithubAuditSyncService`), Copilot usage sync, the digest card's org name
  (`NotificationsService.resolveGithubOrganization`), and the default-repo bridge.
- Repos are collected per `Connection` (`config.repoFullName`), so the 5-minute
  poller already collects any org's repo it is given; its rate budget is
  divided per `tenantId:secretRef`.
- **Existing leak:** the audit route's `registeredRepos(tenantId)` returns every
  active GitHub connection in the tenant, so a hand-registered repo of another
  org is pulled into the hourly full sweep and its refusal guard.
- `GithubAuditCheckpoint.tenantId` is `@unique` (one per tenant); it already
  stores `organization`. `GithubAuditRun` has no org column.
- `GithubCopilotSync` is already keyed `[tenantId, org]`. `GithubRefTip` and
  push ranges are keyed by repo, which embeds the org.
- Changing the Organization field today silently re-points the audit route,
  org sync, Copilot, the digest wording and the default-repo connection. There
  is no frontend for adding a repo connection.

## 3. Schema and migration

**Configuration rows (no schema change).**
- `athmahealth` stays `github/default`, untouched.
- Each further org is a row keyed `github/<lowercased org login>` with the same
  field set (organization, tokenRef, auditLogTokenRef, copilotMetricsTokenRef,
  backfillDays, syncIntervalMinutes, apiBaseUrl). No `defaultRepo` on
  non-default rows.
- Org login is unique across a tenant's GitHub rows (case-insensitive).
- `organization` is immutable once saved, on every row including `default`.
  A row can be disabled, never re-pointed or deleted.
- Token refs left blank on a non-default row resolve to the `default` row's
  ref (read-time fallback, shown as "effective" in the UI).

**`GithubAuditCheckpoint`:** replace `tenantId @unique` with
`@@unique([tenantId, organization])`. The existing row already carries
`organization = athmahealth`, so no data rewrite.

**`GithubAuditRun`:** add `organization String?`; backfill existing rows from
the tenant's checkpoint organization; index `[tenantId, organization, startedAt]`.
New runs always set it.

**`orgOfRepo(repoFullName)`:** single helper returning the lowercased prefix
before `/`. All org filtering of connections, ranges and tips goes through it.

**Migration:** one additive migration (column, backfill, constraint swap).
Applied by hand on the host with `prisma migrate deploy` before the new build
starts. The previous build only writes `athmahealth` rows and still runs
against the new schema, so rollback is a redeploy.

## 4. Collectors and scheduling

Org-wide jobs run **once per active GitHub row, sequentially**, ordered by row
`createdAt` (so `default`/athmahealth first). Each pass has its own settings,
state and run record. A pass's failure (refused token, rate limit, exception)
marks only that org's run; the loop always continues.

**Unchanged, already per repo:** the poller, backfill, commit/PR/review/message
reconcilers, PR-commit backfill, "Sync now". athmahealth connections are not
modified.

**Org sync.**
- Scheduler iterates active GitHub rows and calls
  `syncOrgRepos(tenantId, org, effectiveTokenRef, token, backfillDays)` per row.
- Only repos GitHub lists for that org are created/updated, with that row's
  token ref.
- Guard: an existing connection whose `orgOfRepo` differs from the org being
  synced is skipped and logged, never re-pointed.

**Audit-log route and full sweep (`GithubAuditSyncService`).**
- `loadSettings(tenantId)` → `loadSettings(tenantId, row)`.
- `registeredRepos(tenantId)` → `registeredRepos(tenantId, org)`, filtered by
  `orgOfRepo`. Fixes the leak in §2.
- Checkpoint, seeding, discovery window, lag warning, refusal guard, run-level
  core budget, pending/failed range execution and auto-registration are all
  scoped to `(tenantId, org)`. Auto-registration uses the row's effective
  collector token ref.
- Per-org passes never run concurrently within a tenant, so a shared token's
  rate reading is never interleaved between orgs.
- Status/coverage/report readers (`status`, `coverageForDay`,
  `GithubAuditReportService`) take an org and filter runs, checkpoint and
  ranges by it.

**Copilot usage sync.** Iterates rows with an effective
`copilotMetricsTokenRef`; storage is already per org. A row without one is
skipped and recorded for that row only.

**Default-repo bridge.** `default` row only, as today.

**Env tunables stay global** (`GITHUB_ORG_SYNC_HOURS`, `GITHUB_AUDIT_SYNC_MODE`,
full-sweep cadence, `GITHUB_BACKFILL_RATE_RESERVE`, `GITHUB_COPILOT_USAGE_SYNC`).

**Net effect on athmahealth:** each audit tick takes longer (its pass is
followed by others'), and the digest gate also waits on included orgs (§6).
Nothing else changes.

## 5. Admin API and UI

All routes are under `/api/admin/configurations`, `ADMIN` role, tenant-scoped,
audit-logged.

- `PUT /` (existing upsert) accepts `github/<org>` keys with the §3 validation:
  key = lowercased valid login, login unique, `organization` immutable
  (400: "Organisation cannot be changed — add a new organisation instead").
- Org-scoped routes accept an optional `organization`; when omitted they act on
  the `default` row's org, so existing callers are unchanged:
  `POST github/sync-org`, `POST github/audit-sync/run`,
  `GET github/audit-sync/status`, `GET github/audit-sync/ranges`,
  `POST github/copilot-sync`, `GET github/copilot-sync/status`.
- Tenant-wide routes stay unscoped: reconcile endpoints, `backfill-pr-commits`,
  `commit-collection-coverage`, `:source/rebackfill`.
- New `GET github/organizations`: each row's org, status, effective token-ref
  **names** (never values), and last org-sync / audit / Copilot result.

**UI (Admin → Configurations → GitHub).**
- One card per org, `default` first. The existing form becomes the first card,
  same fields and behaviour; Organization shown read-only.
- "Add organisation" opens an empty card: login entered once then locked, no
  Default repository field, ref placeholders show inherited values
  ("blank = GITHUB_TOKEN from athmahealth"). Each card has its own Save,
  Sync org, audit-sync and Copilot status.
- Sync Status: audit-sync panel shows one row per org (last run, status, lag).
  Per-connection table unchanged.
- Built from existing primitives and design tokens (DESIGN-SYSTEM.md); no raw
  palette classes.

## 6. Digest, Watchlist, Copilot column

**Digest (ADR-0009) — combined, decided by the product owner 2026-11-16.**
- Rule unchanged and still the one `activeDeveloperSet`: a non-merge commit
  that changed files on the previous working day, now in **any included org**.
  Suppressions, alphabetical order, run records and audit unchanged.
- Card lead-in names every included org in row order, e.g. "Below developers
  had no recorded activity in GitHub **athmahealth** and **NHWebsite**
  organisations:". With one org the text is byte-identical to today; the
  all-clear line follows the same pattern.
  `resolveGithubOrganization` → `resolveGithubOrganizations` (list; each login
  validated against the existing pattern).
- **Gate:** `coverageForDay(tenantId, org)` per included org (that org's
  checkpoint, ranges by `orgOfRepo`, latest successful ingest-mode sweep
  started after day end). The digest is sent only if every included org is
  covered; otherwise withheld with a detail naming the uncovered org.
- **Inclusion:** an org is *included* once its first seeding has completed and,
  when the full sweep is enabled (`fullSweepMinutes > 0`, mirroring today's
  gate), it has had one successful ingest-mode full sweep. Until then it is left out
  of the gate and the card, and the run detail notes
  "<org>: collecting, not yet included". A disabled row is not included.

**Watchlist (admin only).** Uses the digest's detection, so it widens with it;
the displayed rule text names the included orgs.

**Copilot column (ADR-0012).** Per developer, across orgs: active days = union
of days, lines added = sum, seat = assigned if assigned in any org. Column
visible once any org has a collected report. Rule text adds which orgs are
covered; freshness shown is the oldest included org's last complete day. Still
never ordered/filtered by, never feeds grade, digest, Watchlist or
notifications.

## 7. Documentation and decisions

- **New ADR-0013** "Multiple GitHub organisations per tenant" (§3–§5).
- **ADR-0009 amendment (2026-11-16):** digest and Watchlist scope widens from
  the one configured org to every included GitHub org of the tenant; rule,
  suppressions, order, run records and audit unchanged; gate requires every
  included org covered.
- **ADR-0012 amendment (2026-11-16):** cross-org Copilot aggregation (§6).
- **CLAUDE.md and AGENTS.md:** amendment lines under the ADR-0009 and ADR-0012
  exceptions, identical in both.
- `docs/api/README.md` (org-scoped params, organizations endpoint, gap
  register), `docs/features/DASHBOARDS.md` (Watchlist / Copilot wording),
  `docs/deployment/README.md` (per-org token refs and fallback),
  `docs/runbooks/` ("Add a GitHub organisation"),
  `docs/architecture/PRODUCT-ARCHITECTURE.md` (collector section).

## 8. Testing

**Regression (acceptance):**
- Only `github/default` configured: org sync calls, audit seed/discovery/sweep
  (repo set, refusal guard), Copilot sync, digest text (named, all-clear,
  withheld reasons) and Watchlist rule text identical to today.
- Adding a second org leaves athmahealth's connections, checkpoint, swept repos,
  refusal count and budget unchanged.
- Second org's token refused / rate-limited / throwing: athmahealth's pass
  succeeds and its checkpoint advances; the other org's run is failed.
- A non-athmahealth connection is never in athmahealth's sweep or refusal count.

**New behaviour:** config validation (unique login, immutable organization,
ref fallback, disable pauses only that row); org-scoped endpoints default to
`default`; digest gate withholds naming the uncovered org; a not-yet-included
org is excluded and noted; a developer active only in the second org is not
named; Copilot union/sum/any-seat; tenant isolation (another tenant's rows,
checkpoints, runs never read); migration preserves the checkpoint and
backfills runs.

**Verification:** backend and frontend unit tests; `rm -rf dist` then
`nest build`; lint (CRLF noise filtered); local run — migrate, confirm
athmahealth Sync Status / audit status / digest dry run unchanged, add
`NHWebsite` and confirm a clear token-refused status until a token exists.

## 9. Rollout

1. PR from `feat/multi-github-org` (branched from `main`).
2. Host: stop backend → `prisma migrate deploy` → deploy build → start.
3. Set the NHWebsite collector token (`GITHUB_TOKEN_NHWEBSITE`, a fine-grained
   PAT with NHWebsite as resource owner, or one classic PAT SSO-authorized for
   both orgs under `GITHUB_TOKEN`). SSO-authorize `GITHUB_AUDIT_TOKEN` (classic)
   for NHWebsite; its owner must be an NHWebsite owner.
4. Admin → Configurations → GitHub → Add organisation `NHWebsite` → Sync org.
5. NHWebsite joins the digest automatically once included (§6).
6. Tracked Developers: add Gopalakrishnan-Sekar_athma, Kathiresan-Ramasamy_athma,
   Manikandan-Ravi_athma now; add Twinkle-Kumari_athma, Vignesh-B-G_athma,
   Vinoth-Rajendran_athma once their GitHub identities exist, merging Jira or
   email identities if they did not auto-link.

**Rollback:** disable the NHWebsite row (stops its org-wide jobs; digest
returns to single-org wording). The migration is additive.

## 10. Out of scope

Org filter on dashboards; separate per-org digests (would need a new product
decision); per-org env tunables.
