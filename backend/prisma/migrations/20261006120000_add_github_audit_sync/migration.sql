-- GitHub audit-log push discovery (ADR-0010). Collector-owned state for the
-- third commit-discovery route: the per-tenant audit checkpoint, run reports,
-- the Compare plan / retry queue, and last-seen branch tips. No commit data is
-- stored here — commits still flow through collectors_raw_event → code_commit.

CREATE TABLE "collectors_github_audit_checkpoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organization" TEXT NOT NULL,
    "seededAt" TIMESTAMP(3),
    "checkpointAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "collectors_github_audit_checkpoint_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "collectors_github_audit_checkpoint_tenantId_key" ON "collectors_github_audit_checkpoint"("tenantId");

CREATE TABLE "collectors_github_audit_run" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "windowFrom" TIMESTAMP(3),
    "windowTo" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "counters" JSONB NOT NULL,
    "error" TEXT,
    CONSTRAINT "collectors_github_audit_run_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "collectors_github_audit_run_tenantId_startedAt_idx" ON "collectors_github_audit_run"("tenantId", "startedAt");

CREATE TABLE "collectors_github_push_range" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "baseSha" TEXT,
    "baseRef" TEXT,
    "headSha" TEXT,
    "kind" TEXT NOT NULL,
    "auditDocumentIds" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "commitsFound" INTEGER NOT NULL DEFAULT 0,
    "alreadyPresent" INTEGER NOT NULL DEFAULT 0,
    "ingested" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "collectors_github_push_range_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "collectors_github_push_range_tenantId_status_idx" ON "collectors_github_push_range"("tenantId", "status");
CREATE INDEX "collectors_github_push_range_tenantId_createdAt_idx" ON "collectors_github_push_range"("tenantId", "createdAt");

CREATE TABLE "collectors_github_ref_tip" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "collectors_github_ref_tip_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "collectors_github_ref_tip_tenantId_repoFullName_ref_key" ON "collectors_github_ref_tip"("tenantId", "repoFullName", "ref");
