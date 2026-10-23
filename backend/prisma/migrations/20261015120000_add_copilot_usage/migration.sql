-- Copilot usage metrics (ADR-0012): the collector's sync cursor (collectors_)
-- and the code context's projections of GitHub's users-1-day reports and
-- seat snapshot (code_). Additive only; no existing table changes.

-- CreateTable
CREATE TABLE "collectors_github_copilot_sync" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "org" TEXT NOT NULL,
    "lastCompleteDay" DATE,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collectors_github_copilot_sync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_copilot_usage_day" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "org" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "githubUserId" BIGINT NOT NULL,
    "login" TEXT NOT NULL,
    "interactions" INTEGER NOT NULL DEFAULT 0,
    "generations" INTEGER NOT NULL DEFAULT 0,
    "acceptances" INTEGER NOT NULL DEFAULT 0,
    "locSuggestedAdd" INTEGER NOT NULL DEFAULT 0,
    "locSuggestedDelete" INTEGER NOT NULL DEFAULT 0,
    "locAdded" INTEGER NOT NULL DEFAULT 0,
    "locDeleted" INTEGER NOT NULL DEFAULT 0,
    "usedAgent" BOOLEAN NOT NULL DEFAULT false,
    "usedChat" BOOLEAN NOT NULL DEFAULT false,
    "usedCli" BOOLEAN NOT NULL DEFAULT false,
    "usedCodingAgent" BOOLEAN NOT NULL DEFAULT false,
    "aiCreditsUsed" DECIMAL(14,4),
    "rawEventId" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_copilot_usage_day_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_copilot_report_day" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "org" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "userCount" INTEGER NOT NULL,
    "rawEventId" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_copilot_report_day_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_copilot_seat" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "org" TEXT NOT NULL,
    "githubUserId" BIGINT NOT NULL,
    "login" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "lastActivityEditor" TEXT,
    "pendingCancellationDate" DATE,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "rawEventId" TEXT NOT NULL,

    CONSTRAINT "code_copilot_seat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "collectors_github_copilot_sync_tenantId_org_key" ON "collectors_github_copilot_sync"("tenantId", "org");

-- CreateIndex
CREATE INDEX "code_copilot_usage_day_tenantId_day_idx" ON "code_copilot_usage_day"("tenantId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "code_copilot_usage_day_tenantId_org_day_githubUserId_key" ON "code_copilot_usage_day"("tenantId", "org", "day", "githubUserId");

-- CreateIndex
CREATE UNIQUE INDEX "code_copilot_report_day_tenantId_org_day_key" ON "code_copilot_report_day"("tenantId", "org", "day");

-- CreateIndex
CREATE UNIQUE INDEX "code_copilot_seat_tenantId_org_githubUserId_key" ON "code_copilot_seat"("tenantId", "org", "githubUserId");

