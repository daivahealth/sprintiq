-- AlterTable
ALTER TABLE "tenant_configuration" ALTER COLUMN "values" DROP DEFAULT,
ALTER COLUMN "secretRefs" DROP DEFAULT;

-- CreateTable
CREATE TABLE "connections_tenant_secret" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connections_tenant_secret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connections_tenant_secret_tenantId_ref_key" ON "connections_tenant_secret"("tenantId", "ref");
