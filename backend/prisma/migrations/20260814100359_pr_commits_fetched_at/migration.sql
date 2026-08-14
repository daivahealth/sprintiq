-- AlterTable
ALTER TABLE "code_pull_request" ADD COLUMN     "commitsFetchedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "code_pull_request_tenantId_commitsFetchedAt_idx" ON "code_pull_request"("tenantId", "commitsFetchedAt");

-- RenameIndex
ALTER INDEX "correlation_developer_identity_tenantId_canonicalDeveloperId_id" RENAME TO "correlation_developer_identity_tenantId_canonicalDeveloperI_idx";

-- RenameIndex
ALTER INDEX "correlation_developer_identity_tenantId_sourceSystem_sourceKey_" RENAME TO "correlation_developer_identity_tenantId_sourceSystem_source_key";
