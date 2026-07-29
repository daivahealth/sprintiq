-- AlterTable
ALTER TABLE "connections_connection" ADD COLUMN     "backfillCompletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "collectors_scheduler_run" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "totalConnections" INTEGER NOT NULL DEFAULT 0,
    "connectionsProcessed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "collectors_scheduler_run_pkey" PRIMARY KEY ("id")
);
