-- AlterTable
ALTER TABLE "connections_connection" ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastErrorAt" TIMESTAMP(3);
