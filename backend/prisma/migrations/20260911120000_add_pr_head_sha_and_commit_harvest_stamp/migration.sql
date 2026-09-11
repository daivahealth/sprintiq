-- api/README.md §12 #51 — commits were collected from the default branch only.
--
-- Two columns, two distinct jobs:
--
--  * "headSha" is the completeness key. A merged PR whose head commit has no
--    code_commit row is a commit that was never collected — the only check
--    independent of the collector's own cursors, which can attest that a walk
--    finished but never that it walked the right branch. Nullable because a PR
--    collected before this existed has no value for it, and that must read as
--    "unknown", never as "no gap".
--
--  * "commitShasFetchedAt" is the backfill's asked-about stamp. Deliberately
--    NOT a reuse of "commitsFetchedAt": that one is already set on essentially
--    every PR (21,930 of 21,931 on the reference tenant) because the
--    2026-08-14 message reconciler asked them all, so reusing it would retire
--    every candidate before the backfill collected anything — the §12 #6 trap
--    repeated one stamp later.
--
-- Both are additive and nullable, so this is safe to apply to a live database
-- ahead of the code that writes them.

ALTER TABLE "code_pull_request" ADD COLUMN "headSha" TEXT;
ALTER TABLE "code_pull_request" ADD COLUMN "commitShasFetchedAt" TIMESTAMP(3);

-- Drives the reconciler's candidate scan.
CREATE INDEX "code_pull_request_tenantId_commitShasFetchedAt_idx"
  ON "code_pull_request"("tenantId", "commitShasFetchedAt");

-- Supports the completeness anti-join (merged PRs whose headSha has no commit).
CREATE INDEX "code_pull_request_tenantId_headSha_idx"
  ON "code_pull_request"("tenantId", "headSha");
