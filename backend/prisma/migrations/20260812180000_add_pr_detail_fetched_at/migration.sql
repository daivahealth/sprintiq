-- AlterTable
ALTER TABLE "code_pull_request" ADD COLUMN     "detailFetchedAt" TIMESTAMP(3);

-- The reconciler's candidate query.
CREATE INDEX "code_pull_request_tenantId_detailFetchedAt_idx" ON "code_pull_request"("tenantId", "detailFetchedAt");
