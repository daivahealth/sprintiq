-- AlterTable
ALTER TABLE "code_pull_request" ADD COLUMN     "reviewsFetchedAt" TIMESTAMP(3);

-- Index the reconciler's candidate query: PRs whose reviews have never been fetched.
CREATE INDEX "code_pull_request_tenantId_reviewsFetchedAt_idx" ON "code_pull_request"("tenantId", "reviewsFetchedAt");
