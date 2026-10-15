# Audit-sync completeness hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make commit collection from go-live onward complete and self-policing. A failed or lagging audit sync must be visible within minutes, pushes the audit log never records must still be collected, pushes to unregistered repos must not be dropped, and the digest must refuse to name anyone for a day the audit route cannot vouch for.

**Architecture:** Five changes to the audit-log route that PR #40 added (BC-1). They extend `GithubAuditSyncService`, add one cron, add one gate to `NoCommitDetectionService` through a read-only method exported by the collector context, and add one migration.

**Tech Stack:** NestJS 10, TypeScript, Prisma/PostgreSQL, `@nestjs/schedule`, Jest.

**Spec:** [docs/superpowers/specs/2026-10-06-github-audit-log-commit-discovery-design.md](../specs/2026-10-06-github-audit-log-commit-discovery-design.md). The follow-up design was agreed in conversation on 2026-10-12; it is summarised under "Design" below.

## Global Constraints

- All GitHub I/O stays in `backend/src/collectors/`; commits are ingested only through `IngestionService.ingest` with key `github:{repo}:commit:{sha}` via `buildCommitEnvelope`.
- Every query carries `tenantId`; never log or store tokens.
- New env vars are parsed only in `github-audit.config.ts` (`readGithubAuditConfig`), boot-validated through `validateEnv`, and documented blank in `backend/.env.example`.
- The migration `20261006120000_add_github_audit_sync` is already applied to a local DB, so it must **not** be edited. Schema changes go in a new migration, `20261012120000_audit_sync_hardening`.
- Respect the run claim (`GithubAuditCheckpoint.runningSince`), the core budget (`ctx.coreBudget` / `chargeCore`) and `forEachBounded`.
- Ethics: a gap must only ever withhold names, never add them. Unattributed authors are never treated as idle.
- Lint gate: `npx eslint -f unix <files> 2>/dev/null | grep -v '␍' | grep -c '\.ts:'` must print 0. Typecheck must be clean. All of `npx jest src/collectors src/metrics src/modules` must pass.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Design (agreed 2026-10-12)

1. **Org-wide refusal guard.** A seeding pass that seeds 0 repos, or where at least half the attempted repos come back `forbidden`, is `failed` (not `seeded`). In that case `seededAt` and `checkpointAt` are not set, and `run.error` names the cause: "collector token refused for N of M repos — check token scope/SSO".
2. **Lag visibility.** New env `GITHUB_AUDIT_LAG_WARN_MINUTES` (default 30, range 5–1440).
   - At the start of each run, lag = now − pre-run checkpoint. If it exceeds the threshold, log a warning and prefix `run.error` with "Audit sync is N minutes behind".
   - New `GithubAuditSyncService.status(tenantId)` returns `{ mode, enabled, seededAt, checkpointAt, lagMinutes, behind, lastRunAt, lastStatus, lastError, pendingRanges, failedRanges }`, exposed as ADMIN `GET /admin/configurations/github/audit-sync/status`.
3. **Full branch sweep (backstop for web/API pushes and anything the audit log misses).** New cron `GithubAuditSchedulerService.sweepTick` on env `GITHUB_AUDIT_FULL_SWEEP_MINUTES` (default 60; allowed 0 = off, 30, 60, 120, 240), with the same mode/role gating as `tick`. New `GithubAuditSyncService.runFullSweep(tenantId, cfg?, now?)`:
   - takes the same per-tenant claim and creates a run row with `trigger = 'full_sweep'` (new column `GithubAuditRun.trigger String @default("audit")`; the existing audit runs are `'audit'`);
   - runs `planRepo` over **every** registered repo, with `auditDocumentIds: []` and the budget respected; unseeded repos are seeded;
   - then runs `executePending`;
   - **never** reads the audit log and **never** moves `checkpointAt`.
4. **Auto-register repos the audit log reveals.** In `discover`, a push to a repo with **no connection at all** in the tenant (any status; a disabled connection is an admin decision and is left alone):
   - check the repo with `getDefaultBranch`, extended to also return `archived` / `disabled`; archived, disabled, 404 and 403 repos are skipped and counted;
   - create the connection exactly as `GithubOrgSyncService` does (`name` = full name, `config { repoFullName, backfillSince }`, `secretRef` = the GitHub configuration's `tokenRef`, `backfillSince` from its `backfillDays`, default 90);
   - seed its tips;
   - plan a `new_ref` range for every non-default branch, but only when the repo has ≤ `GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES` (default 50, range 0–500) branches; above that, seed only and note it in `run.error`.

   New counter `reposRegistered`. The regular collector then backfills the repo's history as for any org-synced repo.
5. **Digest gate (seal).** New read-only `GithubAuditSyncService.coverageForDay(tenantId, dayKey)` returns `{ applies: boolean; ok: boolean; reasons: string[] }`.
   - `applies` is true only when mode is `ingest` and the tenant has an audit-log token ref.
   - `ok` requires all of:
     - `checkpointAt ≥ istDayEnd(day) + overlapMinutes`;
     - no `pending` or `failed` range with `createdAt` in [`istDayStart(day)`, `istDayEnd(day) + overlap + 60 min`];
     - the last **full sweep** run finished after `istDayEnd(day)` with status `success`, when the sweep is enabled.
   - `reasons` names the cause, with up to 5 repos.

   `NoCommitDetectionService` gets it through `@Optional()` injection (MetricsModule imports CollectorsModule; check there is no cycle). Directly after gate 1 it adds a gate: when `applies && !ok`, the outcome is `withheld_stale_data` with detail "GitHub audit sync has not covered <day>: …. Names withheld." When `applies` is false, behaviour is unchanged.

## File map

- `backend/src/collectors/sources/github/github-audit.config.ts` (+ spec): 3 new env vars.
- `backend/src/collectors/sources/github/github-audit-sync.service.ts` (+ specs and fakes): items 1–5.
- `backend/src/collectors/sources/github/github.client.ts` (+ compare client spec): `getDefaultBranch` also returns `archived` / `disabled`.
- `backend/src/collectors/scheduler/github-audit-scheduler.service.ts` (+ spec): `sweepTick`.
- `backend/prisma/schema.prisma` + new migration `20261012120000_audit_sync_hardening`: `GithubAuditRun.trigger`.
- `backend/src/modules/configurations/configurations.controller.ts`: the status endpoint.
- `backend/src/metrics/no-commit-detection.service.ts` (+ spec), `backend/src/metrics/metrics.module.ts`: the gate.
- `backend/tsconfig.build.json`: exclude `**/*.fakes.ts` (a test helper currently compiled into the build).
- Docs: ADR-0010 ("2026-10-12 update" section), `docs/api/README.md` §3/§9/§12 (#58 web pushes now covered by the sweep; #57 text), `docs/features/NOTIFICATIONS.md` §4 gate table, `docs/deployment/README.md` §5/§6.5, `docs/architecture/DATA-MODEL.md` (`trigger` column), `backend/.env.example`.

## Tasks

### Task 1: Refusal guard, lag status and status endpoint, build exclude
Items 1 and 2, `GITHUB_AUDIT_LAG_WARN_MINUTES`, `tsconfig.build.json` exclude. Tests:
- seeding where every repo returns 403 → `failed`, `seededAt` unset;
- 3 of 4 repos return 403 → `failed`;
- 1 of 4 → `seeded`, with `reposUnseedable` 1;
- a lag warning recorded in `run.error` when the pre-run checkpoint is older than the threshold;
- `status()` fields and tenant isolation;
- config parsing, default and range for the new env var.

### Task 2: Full branch sweep
Item 3, the migration, `GITHUB_AUDIT_FULL_SWEEP_MINUTES` and `sweepTick`. Tests:
- the sweep plans ranges for a moved branch in a repo with no audit push;
- it never calls the audit client and never changes `checkpointAt`;
- it respects the claim (skipped while held);
- the run row has `trigger: 'full_sweep'`;
- the budget stop holds the remaining repos;
- interval 0 means no sweep, and an invalid interval fails boot;
- the scheduler gating matches `tick`.

### Task 3: Auto-register unregistered repos
Item 4, `GITHUB_AUDIT_NEW_REPO_MAX_BRANCHES` and the `getDefaultBranch` extension. Tests:
- an unregistered pushed repo → connection created with the org-sync shape, seeded, and `new_ref` ranges for its non-default branches;
- archived / 404 / 403 → skipped;
- an existing disabled connection → not touched;
- over the branch cap → seed only, with a note;
- `reposRegistered` counter;
- the existing "unregistered repo is skipped" expectations updated, with the reason stated.

### Task 4: Digest gate
Item 5. Tests in the collector spec for `coverageForDay`:
- each failing condition and its reason;
- `applies` false when mode is not `ingest` or no ref is set;
- tenant scoping.

Tests in the no-commit detection spec:
- gate withholds with the expected detail when `applies && !ok`;
- unchanged when `applies` is false or the service is absent;
- runs after gate 1.

The existing digest tenant-isolation test must keep passing.

### Task 5: Documentation
All doc updates listed in the file map, verified against the code (env names, defaults, endpoint path, gate wording). Gap rows #55 and #56 must keep their numbers. Gap #58 is updated to say web/API pushes are now caught by the hourly sweep, within one sweep interval.
