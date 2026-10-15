# Branch tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Record which branches every collected commit was found on, merged or not, and show each developer's branches on the Developer page. New branches are read from their own history rather than compared with `master`.

**Architecture:**
- The audit-log route (BC-1) emits one `code.commit.branch_observed` envelope per commit per branch it fetches.
- The code context projects those envelopes into a new `code_commit_branch` table.
- The developer-activity read (BC-8, through `CodeService`) groups that person's commits by repo and branch, with a status label taken from collected PRs.
- The Developer page lists the result.
- New branches are read with `listBranchCommits` over a configurable look-back. Compare is used only for known branches that moved.

**Tech Stack:** NestJS 10, Prisma/PostgreSQL, React + Tailwind, Jest/Vitest.

**Spec:** [docs/superpowers/specs/2026-10-06-github-audit-log-commit-discovery-design.md](../specs/2026-10-06-github-audit-log-commit-discovery-design.md). The follow-up design was agreed in conversation on 2026-10-14 and is summarised under "Design" below.

## Global Constraints

- GitHub I/O stays in `backend/src/collectors/`. Domain tables are written only by projectors off the ingestion pipeline: no direct writes from collectors.
- Every query and row is tenant-scoped.
- Merge status never filters anything. It appears only as a label.
- Ordering of branches is by last activity, never by volume. No per-developer comparison is added (CLAUDE.md "Metrics are ethics-first").
- New env vars are parsed only in `github-audit.config.ts`, boot-validated through `validateEnv`, and documented blank in `backend/.env.example`.
- New migrations only. Existing migrations are already applied to a local DB and must not be edited.
- Never touch a database outside tests; migrations are applied by hand.
- Lint gate: `npx eslint -f unix <files> 2>/dev/null | grep -v '␍' | grep -c '\.ts:'` must print 0. `tsc` must be clean and all tests must pass.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Design (agreed 2026-10-14)

1. **New-branch rule.**
   - `new_ref` ranges are read with `listBranchCommits(head, since = range.createdAt − lookbackDays)`. There is no Compare against the default branch.
   - A `moved` range whose Compare returns `not_found` (old tip garbage-collected) or `no_common_ancestor` falls back to the same read. The default-branch Compare retry is removed.
   - New env var `GITHUB_AUDIT_NEW_BRANCH_LOOKBACK_DAYS`: default 30, range 1–90.
   - `UNRELATED_HISTORY_LOOKBACK_MS` is replaced by this setting.
2. **Branch links.**
   - New event type `code.commit.branch_observed`, with idempotency key `github:{repo}:branch:{ref}:commit:{sha}`.
   - Payload: `{ repoFullName, branch, sha, observedAt }`. `observedAt` is the run time, and the envelope's `occurredAt` is the same value.
   - Emitted in **ingest mode only**, for **every** commit of a range that completes: newly ingested, already present, and seen earlier in the same run. Shadow mode emits none.
   - Emitted after the commit's own envelope for a newly ingested commit.
   - Built by a function next to `buildCommitEnvelope`.
   - New Prisma model `CommitBranch` mapped to `code_commit_branch`: `id`, `tenantId`, `repoFullName`, `branch`, `sha`, `firstSeenAt`, unique (`tenantId`, `repoFullName`, `branch`, `sha`), index (`tenantId`, `repoFullName`, `sha`).
   - `CodeService` subscribes and upserts the row. `firstSeenAt` is the earliest `observedAt`, so an update never moves it later.
   - New counter `branchLinks` (count of accepted branch-observed envelopes).
3. **Developer branches.**
   - New `CodeService` method that takes a tenant, a list of `{ repoFullName, sha }`, and returns their branch links. It is the only reader of the table, so BC-8 never touches it directly.
   - `InsightsService.developerActivity` adds `branches: { repoFullName, branch, commits, locChanged, lastCommitAt, prStatus: 'merged' | 'open' | 'closed' | 'none' }[]` for the window, grouping the developer's commits by repo and branch. A commit on several branches counts on each.
   - `prStatus` comes from that repo's collected PRs whose head branch equals the branch name: any merged → `merged`, else any open → `open`, else any closed → `closed`, else `none`.
   - Ordered by `lastCommitAt` descending. Capped at 50 rows, with `branchesTotal` giving the full count.
   - The Developer page gets a **Branches** section: a table of branch, repo, PR status badge, commits, changed lines and last commit, ordered by last activity.
     - When empty, it explains that branch names come from the audit-log route in ingest mode.
     - A note says this is activity on branches, merged or not, and is not a ranking.
     - Frontend types are optional (`branches?`), so an older API renders "not available".

## Tasks

### Task 1: New-branch rule
Implement Design item 1 in `github-audit-sync.service.ts` (`compareRange`) and `github-audit.config.ts`, plus the env var in `.env.example` and boot validation. Update the existing execute-spec tests that expect a default-branch Compare for `new_ref` or `moved`, stating why each changed.

Tests:
- A `new_ref` range calls `listBranchCommits` with `since = createdAt − 30d` and never calls `compareAll`.
- A custom look-back of 10 days changes `since` accordingly.
- A `moved` range that gets `not_found` falls back to `listBranchCommits`.
- A `moved` range that gets `no_common_ancestor` falls back to `listBranchCommits`.
- A `moved` range with a normal result never calls `listBranchCommits`.
- Config: default 30, range 1–90 enforced, and boot fails on 0 or 91.

### Task 2: Branch links: event, table, projector
Implement Design item 2: the new migration `20261014120000_commit_branch`, the `CommitBranch` model, the event type, the envelope builder, emission in `executeRange`, the `CodeService` subscription and upsert, and the counter.

Tests:
- In ingest mode, a range emits one branch envelope per commit, including already-present and seen-in-run commits, with the right key and payload.
- Shadow mode emits none.
- A failed or partial range emits none for the commits not processed.
- The projector creates the row once, never moves `firstSeenAt` later, and is tenant-scoped.
- The builder's key format.

### Task 3: Developer branches: API and UI
Implement Design item 3: the `CodeService` reader, `developerActivity.branches` and `branchesTotal`, the frontend types, and the Developer page section with an empty state.

Tests:
- Grouping counts a commit on two branches on both.
- Changed lines and last commit are correct.
- `prStatus` precedence is merged > open > closed > none.
- Rows are ordered by last commit, with the 50-row cap and `branchesTotal`.
- Tenant scoping.
- A frontend render test for the section: rows, badges, the empty state, and no NaN.

### Task 4: Docs
- ADR-0010: a "2026-10-14 update: branch tracking and the new-branch rule" section. It supersedes the "no common ancestor" fallback wording in the earlier 2026-10-14 note: the fallback still exists, but new branches now always read their own history.
- `docs/architecture/DATA-MODEL.md`: `code_commit_branch`.
- `docs/api/README.md`: §3 (new-branch rule, branch-observed event), §9 (`branches[]` and `branchesTotal` on developer-activity).
- `docs/features/DASHBOARDS.md` §4.4.3: the Branches section.
- `docs/deployment/README.md`: the new migration in the §6.5 migration list, and the env var in the §5 table.
- `backend/.env.example`: verify the env var entry.
