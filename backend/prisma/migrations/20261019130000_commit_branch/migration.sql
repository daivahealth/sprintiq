-- Branch tracking (2026-10-19): which branches each commit has been seen on,
-- merged or not. Projected from code.commit.branch_observed. Additive.
CREATE TABLE "code_commit_branch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_commit_branch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "code_commit_branch_tenantId_repoFullName_branch_sha_key" ON "code_commit_branch"("tenantId", "repoFullName", "branch", "sha");
CREATE INDEX "code_commit_branch_tenantId_repoFullName_sha_idx" ON "code_commit_branch"("tenantId", "repoFullName", "sha");
