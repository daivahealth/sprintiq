-- AlterTable
ALTER TABLE "code_pull_request" ADD COLUMN     "mergedBy" TEXT;

-- CreateTable
CREATE TABLE "code_pr_review" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "externalNumber" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "reviewerLogin" TEXT,
    "state" TEXT NOT NULL,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "hasBody" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_pr_review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "code_pr_review_tenantId_externalId_key" ON "code_pr_review"("tenantId", "externalId");

-- CreateIndex
CREATE INDEX "code_pr_review_tenantId_repoFullName_externalNumber_idx" ON "code_pr_review"("tenantId", "repoFullName", "externalNumber");

-- CreateIndex
CREATE INDEX "code_pr_review_tenantId_reviewerLogin_submittedAt_idx" ON "code_pr_review"("tenantId", "reviewerLogin", "submittedAt");
