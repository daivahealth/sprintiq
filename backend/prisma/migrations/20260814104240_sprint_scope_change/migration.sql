-- CreateTable
CREATE TABLE "planning_sprint_scope_change" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "sprintExternalId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "changelogId" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "authorLogin" TEXT,
    "authorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planning_sprint_scope_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "planning_sprint_scope_change_tenantId_sprintExternalId_chan_idx" ON "planning_sprint_scope_change"("tenantId", "sprintExternalId", "changedAt");

-- CreateIndex
CREATE INDEX "planning_sprint_scope_change_tenantId_externalKey_idx" ON "planning_sprint_scope_change"("tenantId", "externalKey");

-- CreateIndex
CREATE UNIQUE INDEX "planning_sprint_scope_change_tenantId_connectionId_changelo_key" ON "planning_sprint_scope_change"("tenantId", "connectionId", "changelogId", "sprintExternalId");
