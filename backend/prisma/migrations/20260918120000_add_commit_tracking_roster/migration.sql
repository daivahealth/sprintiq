-- CreateTable
CREATE TABLE "notification_tracked_developer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "canonicalDeveloperId" TEXT NOT NULL,
    "addedAs" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_tracked_developer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_no_commit_run" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportedDay" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "rosterCount" INTEGER NOT NULL,
    "flaggedCount" INTEGER NOT NULL,
    "flagged" JSONB NOT NULL,
    "unresolved" JSONB NOT NULL,
    "incomplete" JSONB NOT NULL,
    "detail" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_no_commit_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_tracked_developer_tenantId_canonicalDeveloperId_key" ON "notification_tracked_developer"("tenantId", "canonicalDeveloperId");

-- CreateIndex
CREATE INDEX "notification_tracked_developer_tenantId_active_idx" ON "notification_tracked_developer"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "notification_no_commit_run_tenantId_reportedDay_key" ON "notification_no_commit_run"("tenantId", "reportedDay");

-- CreateIndex
CREATE INDEX "notification_no_commit_run_tenantId_createdAt_idx" ON "notification_no_commit_run"("tenantId", "createdAt");
