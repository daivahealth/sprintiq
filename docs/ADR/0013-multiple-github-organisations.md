# ADR-0013: Multiple GitHub organisations per tenant

- **Status:** Accepted — implemented 2026-11-16
- **Date:** 2026-11-16
- **Deciders:** Product owner, engineering
- **Related:** [ADR-0008](0008-github-graphql-over-webhooks.md), [ADR-0009](0009-attributed-commit-digest.md) (amended), [ADR-0010](0010-github-audit-log-commit-discovery.md), [ADR-0012](0012-per-developer-copilot-usage.md) (amended), [design spec](../superpowers/specs/2026-11-16-multi-github-org-design.md), [api/README.md §3, §9, §12 #71](../api/README.md), [deployment/README.md §5.4](../deployment/README.md), [runbooks/add-github-organisation.md](../runbooks/add-github-organisation.md)

## Context

A tenant could collect from one GitHub organisation only. The first second case is `NHWebsite` beside `athmahealth`. Adding it must not change the behaviour of the organisation already configured: its connections, audit-log checkpoint, swept repos, refusal guard, rate budget and Copilot sync.

What the code did before this decision (verified 2026-11-16):

- **One configuration row.** GitHub config was the single `TenantConfiguration` row `github/default`, with one `organization`. The table already allowed many rows per namespace.
- **Five readers of that one row.** Org sync (button and scheduler), the audit-log route (`GithubAuditSyncService`), Copilot usage sync, the digest card's organisation name, and the default-repo bridge each read `github/default` and nothing else.
- **A sweep leak.** The audit route's `registeredRepos(tenantId)` returned every active GitHub connection in the tenant. A hand-registered repo of another organisation was pulled into the hourly full sweep and into its refusal guard.
- **A bridge hazard.** `ConfigurationsService.upsertTenantConfiguration` ran the default-repo bridge for every `github` key. Saving a second GitHub row without a default repo would have disabled the bridged athmahealth connection; with one, it would have re-pointed it.
- **Silent re-pointing.** Changing the Organization field re-pointed org sync, the audit route, Copilot, the digest wording and the bridged connection at once.
- **One checkpoint per tenant.** `GithubAuditCheckpoint.tenantId` was `@unique`, and `GithubAuditRun` had no organisation column.

The poller, backfill and reconcilers are already per repository (`Connection.config.repoFullName`), and Copilot storage is already keyed by `org`, so neither needed to change.

## Decision

**A tenant has one GitHub configuration row per organisation. Org-wide jobs run once per active row, each with its own state. The daily digest is the one deliberate cross-organisation effect.**

1. **One row per organisation.** `athmahealth` stays `github/default`, untouched. Each further organisation is a row keyed `github/<lowercased login>`, with the same fields except `defaultRepo`. The login is unique across a tenant's GitHub rows, case-insensitively.
2. **The organisation is immutable.** Once saved, `organization` cannot change on any row, including `default`. A row can be disabled, never re-pointed or deleted. This removes the silent re-pointing described above.
3. **Ref inheritance.** A non-default row whose `tokenRef`, `auditLogTokenRef` or `copilotMetricsTokenRef` is blank uses the `default` row's ref. The fallback is applied at read time. The API and UI show effective ref names and which are inherited, never values.
4. **`github-orgs.ts` is the only reader.** `loadGithubOrgs` and `orgOfRepo` (the lowercased owner of `owner/name`) are the one place that lists organisations and filters connections, ranges and tips by organisation. No service reads a `github/*` row directly any more.
5. **Per-organisation audit state.** `GithubAuditCheckpoint` is unique on `(tenantId, organization)`. `GithubAuditRun` gains `organization`, backfilled from the tenant's checkpoint. The run claim sits on the per-organisation checkpoint row. The checkpoint, seeding, discovery window, lag warning, refusal guard, run-level core budget and range execution are scoped to `(tenantId, org)`. This also fixes the sweep leak.
6. **Scheduling.** Org sync, the audit route and Copilot sync run sequentially per active row, ordered by row `createdAt`, so `default` goes first. A pass's failure marks only that organisation's run; the loop continues.
7. **Bridge only for `default`.** Non-default GitHub rows never create, update or disable the bridged default-repo connection.
8. **Ranges and the day report are tenant-wide.** Push ranges already name their repo, so listing, retry, dismiss and the commit report stay unscoped. The report and `GithubActivityVerifyService` read the **oldest** checkpoint across the tenant's organisations, which is the conservative reading.
9. **Digest inclusion** (see the [ADR-0009 amendment](0009-attributed-commit-digest.md#amendment-2026-11-16--every-included-github-organisation)). The `default` row is always included. A non-default active row is `included` once its first seeding has completed and, when the full sweep is enabled, it has had one successful ingest-mode full sweep. A row the audit route does not apply to (mode not `ingest`, or no effective audit-log ref) is included at once. Until then it is `collecting`, and left out of the gate and the card. A disabled row is never included. The gate requires every included organisation to be covered.
10. **Copilot.** Usage is collected per organisation and combined across them (see the [ADR-0012 amendment](0012-per-developer-copilot-usage.md#amendment-2026-11-16--usage-across-github-organisations)). Freshness is the oldest of each organisation's newest report day.
11. **Tunables stay global.** `GITHUB_ORG_SYNC_HOURS`, `GITHUB_AUDIT_SYNC_MODE`, the full-sweep cadence, `GITHUB_BACKFILL_RATE_RESERVE` and `GITHUB_COPILOT_USAGE_SYNC` apply to every organisation.

**Migration** `20261116100000_multi_github_org` is additive: the `organization` column on `GithubAuditRun` with a backfill, an index, and the checkpoint uniqueness swap. It is applied by hand (`npx prisma migrate deploy`) before the new build starts. The swap drops the unique index `collectors_github_audit_checkpoint_tenantId_key`, which the previous build's `githubAuditCheckpoint.upsert({ where: { tenantId } })` relies on (Prisma's native upsert compiles to `ON CONFLICT ("tenantId")`), so the previous build does not run against the new schema and rolling back the build is not a plain redeploy. The preferred rollback is to disable the additional organisation's row (no code rollback). Rolling back the build also requires restoring the index — `CREATE UNIQUE INDEX "collectors_github_audit_checkpoint_tenantId_key" ON "collectors_github_audit_checkpoint"("tenantId");` — which only succeeds while each tenant has exactly one checkpoint row; otherwise first delete the additional organisations' checkpoint rows (`DELETE FROM "collectors_github_audit_checkpoint" WHERE "organization" <> '<default org login>';`). Runs written by the old build after a rollback carry a NULL `organization` and do not appear in per-organisation status after re-deploying.

## Consequences

**Adding an organisation is additive.** It is a new configuration row and a new set of connections. Nothing about an existing organisation's connections, checkpoint, swept repos, refusal count or budget changes. The regression tests assert this.

**Failure is contained, except at the digest gate.** A second organisation whose token is refused, rate-limited or throwing fails only its own run; athmahealth's pass still succeeds and its checkpoint advances. The one deliberate exception is the digest: it is withheld if any *included* organisation is not covered. That fails closed, because a list naming people on data that omits an organisation they work in would be a false claim about absence. Connection liveness (gate 1) also stays tenant-wide, so a stale connection in any organisation withholds the digest.

**Each audit tick takes longer.** athmahealth's pass is followed by the other organisations' passes.

**Manual runs of two organisations may overlap.** This is safe: each pass keeps its own run-level budget, refreshed only from its own token's responses. The scheduler never overlaps them.

**One token covers one organisation unless it is a classic PAT.** A fine-grained PAT is bound to one resource owner, so a second organisation needs its own ref (for example `GITHUB_TOKEN_NHWEBSITE`) or one classic PAT SSO-authorized for all organisations. The audit-log token must belong to an owner of each organisation and be SSO-authorized for it. See [deployment/README.md §5.4](../deployment/README.md).

**A repo whose owner is not a configured organisation is no longer swept.** Before this change the audit route covered every active GitHub connection in the tenant. Now it covers only repos whose owner is a configured, active organisation. Pending or failed push ranges for other repos are no longer executed or refusal-counted. Check for them before deploying ([runbook](../runbooks/add-github-organisation.md)).

**Developers are not scoped per organisation.** Tracked Developers and identities remain tenant-wide. A developer is added once, and activity in any included organisation counts.

## Alternatives considered

**Re-point the single row between organisations.** Rejected: it is what the silent re-pointing hazard already did, and it would drop the first organisation's collection.

**One digest per organisation.** Rejected for now. It would be a different attributed list sent to a different audience, and needs its own product decision. The product owner chose one combined digest.

**A new table for organisations.** Rejected: `TenantConfiguration` already allows many rows per namespace, so the rows need no schema change, and the admin configuration API already validates and audit-logs them.

**Per-organisation env tunables.** Out of scope. One set of tunables is simpler to operate, and no case yet needs them to differ.

**An organisation filter on dashboards.** Out of scope; every dashboard stays tenant-wide.
