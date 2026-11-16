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
- **Existing hazard:** `ConfigurationsService.upsertTenantConfiguration` runs
  the default-repo bridge for *every* `github` key. Saving a second GitHub row
  without a default repo would disable the bridged athmahealth connection; with
  one it would re-point it.
- Copilot storage (`CopilotUsageDay`, `CopilotSeat`, `CopilotReportDay`) is
  already keyed by `org`, seat snapshots are replaced per org, and
  `copilotLookup` already takes the union of days / sum of lines / any seat
  across rows. Only `copilotCoverage` (freshness) reads tenant-wide newest.
- `GithubActivityVerifyService` and `GithubAuditReportService` read the audit
  checkpoint by `tenantId` alone.

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
  token ref (`syncOrgRepos` already looks connections up by the listed
  `full_name`, so it cannot touch another org's connections).

**Default-repo bridge.** Runs only for the `github/default` row (and Jira, as
today). Non-default GitHub rows never create, update or disable the bridged
connection, and their view carries `connection: null`.

**Audit-log route and full sweep (`GithubAuditSyncService`).**
- `loadSettings(tenantId)` → `loadSettings(tenantId, row)`.
- `registeredRepos(tenantId)` → `registeredRepos(tenantId, org)`, filtered by
  `orgOfRepo`. Fixes the leak in §2.
- Checkpoint, seeding, discovery window, lag warning, refusal guard, run-level
  core budget, pending/failed range execution and auto-registration are all
  scoped to `(tenantId, org)`. Auto-registration uses the row's effective
  collector token ref.
- The run claim moves to the per-org checkpoint row. The scheduler runs a
  tenant's orgs one after another; a manual run can overlap another org's
  pass, which is safe because each pass keeps its own `RunContext` budget,
  refreshed only from its own token's responses.
- `status` and `coverageForDay` filter runs, checkpoint and ranges by org.
  `GithubAuditReportService` (day report), `listRanges`, `retryRange`,
  `dismissRange` and `backfillBranchLinks` stay tenant-wide — every range row
  already names its repo. The report and `GithubActivityVerifyService` read the
  **oldest** checkpoint across the tenant's orgs (conservative).
- `rereadBranchHistory` keeps its tenant-wide repo list; a repo whose org has
  not been seeded is returned in `unknown`.

**Copilot usage sync.** Iterates rows with an effective
`copilotMetricsTokenRef`; storage is already per org. A row without one is
skipped and recorded for that row only.

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
- Org-scoped routes accept an optional `organization` (body for POST, query
  for GET); when omitted they act on the `default` row's org, so existing
  callers are unchanged: `POST github/sync-org`, `POST github/audit-sync/run`,
  `GET github/audit-sync/status`, `POST github/copilot-sync`. An unknown or
  disabled organization is a 400.
- Tenant-wide routes stay unscoped: `GET github/audit-sync/ranges`, range
  retry/dismiss, `github/audit-commit-report`, `GET github/copilot-sync/status`
  (already lists every org), reconcile endpoints, `backfill-pr-commits`,
  `commit-collection-coverage`, `:source/rebackfill`.
- New `GET github/organizations`: each row's key, org, status, whether it is
  the default, effective token-ref **names** (never values) with which are
  inherited, its audit status, and its digest inclusion
  (`included` | `collecting` | `disabled`).

**UI (Admin → Configurations → GitHub).**
- The existing form stays the `default` (athmahealth) form, same fields and
  behaviour, except Organization becomes read-only once saved.
- Below it, an "Additional organisations" panel lists every non-default row,
  each with its own fields (Organization locked, token refs with inherited
  placeholders such as "blank = GITHUB_TOKEN from athmahealth",
  backfillDays, syncIntervalMinutes, Enabled), Save, Sync org, and its digest
  inclusion. "Add organisation" adds an empty entry; the login is typed once.
  No Default repository field.
- Sync Status: the existing audit-route panel stays (default org status, all
  ranges). Each additional org gets a compact status row below it (mode,
  enabled, lag, last status/error, digest inclusion). With one org nothing new
  is shown. Per-connection table unchanged.
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
- **Gate:** `coverageForDay(tenantId, day)` keeps its signature and checks each
  included org (that org's checkpoint, ranges whose repo is in the org, latest
  successful ingest-mode sweep started after day end). The digest is sent only
  if every included org is covered; otherwise withheld. Reasons are prefixed
  with the org (`NHWebsite: …`) only when the tenant has more than one active
  GitHub row, so single-org withheld text is byte-identical to today.
- **Inclusion:** the `default` row is always included (as today — a fresh
  tenant still withholds until it is seeded). A non-default active row is
  *included* once its first seeding has completed and, when the full sweep is
  enabled (`fullSweepMinutes > 0`, mirroring today's gate), it has had one
  successful ingest-mode full sweep; a non-default row for which the audit
  route does not apply (mode not `ingest`, or no effective audit-log ref) is
  included immediately. Until included, an org is left out of the gate and the
  card, and shows as `collecting` on the organisations list. A disabled row is
  never included. Partial data from a collecting org can only add activity,
  never name someone.
- `coverageForDay` returns the included org logins; detection passes them to
  the digest, which renders the lead-in from them.
- Gate 1 (connection liveness, `getDataFreshness`) stays tenant-wide by design:
  stale connections in any org withhold the digest.

**Watchlist (admin only).** Uses the digest's detection, so it widens with it.
`DIGEST_RULE_TEXT` is unchanged; when more than one org is included, a scope
line ("Across GitHub organisations: athmahealth, NHWebsite.") is shown with it.

**Copilot column (ADR-0012).** Aggregation across orgs already exists (union of
days, sum of lines, seat in any org). Changes: `copilotCoverage.coveredThrough`
becomes the oldest of each org's newest report day, `reportDaysInWindow`
counts distinct days, and coverage lists the orgs, shown beside the rule when
more than one. Still never ordered/filtered by, never feeds grade, digest,
Watchlist or notifications.

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
- Saving a non-default GitHub row never creates, updates or disables the
  bridged default-repo connection.

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
