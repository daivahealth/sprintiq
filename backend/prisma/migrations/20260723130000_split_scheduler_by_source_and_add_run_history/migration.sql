-- DropTable
DROP TABLE "collectors_scheduler_run";

-- CreateTable
CREATE TABLE "collectors_scheduler_tick" (
    "sourceSystem" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "totalConnections" INTEGER NOT NULL DEFAULT 0,
    "connectionsProcessed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "collectors_scheduler_tick_pkey" PRIMARY KEY ("sourceSystem")
);

-- CreateTable
CREATE TABLE "collectors_connection_sync_run" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "eventsFetched" INTEGER NOT NULL DEFAULT 0,
    "eventsIngested" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "errorMessage" TEXT,

    CONSTRAINT "collectors_connection_sync_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collectors_connection_sync_run_tenantId_sourceSystem_starte_idx" ON "collectors_connection_sync_run"("tenantId", "sourceSystem", "startedAt");

-- CreateIndex
CREATE INDEX "collectors_connection_sync_run_tenantId_connectionId_starte_idx" ON "collectors_connection_sync_run"("tenantId", "connectionId", "startedAt");
