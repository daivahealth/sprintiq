-- Multiple GitHub organisations per tenant (2026-11-16, ADR-0013): the audit
-- checkpoint becomes per organisation and every audit run records its
-- organisation. Additive: the existing checkpoint row already names its
-- organisation, and existing runs are attributed to it.

-- DropIndex
DROP INDEX "collectors_github_audit_checkpoint_tenantId_key";

-- DropIndex
DROP INDEX "collectors_github_audit_run_tenantId_startedAt_idx";

-- AlterTable
ALTER TABLE "collectors_github_audit_run" ADD COLUMN     "organization" TEXT;

UPDATE "collectors_github_audit_run" AS r
SET "organization" = c."organization"
FROM "collectors_github_audit_checkpoint" AS c
WHERE c."tenantId" = r."tenantId" AND r."organization" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "collectors_github_audit_checkpoint_tenantId_organization_key" ON "collectors_github_audit_checkpoint"("tenantId", "organization");

-- CreateIndex
CREATE INDEX "collectors_github_audit_run_tenantId_organization_startedAt_idx" ON "collectors_github_audit_run"("tenantId", "organization", "startedAt");
