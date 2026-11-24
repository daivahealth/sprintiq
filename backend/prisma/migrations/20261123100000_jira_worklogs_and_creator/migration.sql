-- Jira worklogs and issue creator (2026-11-23, ADR-0014 — Sprint Health
-- Efforts). Additive only: three nullable columns on planning_story and one new
-- table. Existing rows stay null until the collector re-reads them or
-- JiraWorklogReconcilerService fills them; null is disclosed, never guessed.

-- AlterTable
ALTER TABLE "planning_story" ADD COLUMN     "creatorLogin" TEXT,
ADD COLUMN     "creatorName" TEXT,
ADD COLUMN     "worklogsCollectedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "planning_worklog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "sourceWorklogId" TEXT NOT NULL,
    "authorLogin" TEXT,
    "authorName" TEXT,
    "authorEmail" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "timeSpentSeconds" INTEGER NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "rawEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planning_worklog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "planning_worklog_tenantId_externalKey_idx" ON "planning_worklog"("tenantId", "externalKey");

-- CreateIndex
CREATE INDEX "planning_worklog_tenantId_startedAt_idx" ON "planning_worklog"("tenantId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "planning_worklog_tenantId_connectionId_sourceWorklogId_key" ON "planning_worklog"("tenantId", "connectionId", "sourceWorklogId");
