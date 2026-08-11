-- AlterTable
ALTER TABLE "planning_story" ADD COLUMN     "statusCategory" TEXT;

-- CreateTable
CREATE TABLE "planning_issue_status_history" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "changelogId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "transitionedAt" TIMESTAMP(3) NOT NULL,
    "authorLogin" TEXT,
    "authorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planning_issue_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "planning_issue_status_history_tenantId_externalKey_transiti_idx" ON "planning_issue_status_history"("tenantId", "externalKey", "transitionedAt");

-- CreateIndex
CREATE UNIQUE INDEX "planning_issue_status_history_tenantId_connectionId_changel_key" ON "planning_issue_status_history"("tenantId", "connectionId", "changelogId");
