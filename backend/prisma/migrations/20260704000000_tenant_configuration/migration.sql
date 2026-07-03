-- CreateTable
CREATE TABLE "tenant_configuration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT 'default',
    "values" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "secretRefs" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_configuration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_configuration_tenantId_namespace_idx" ON "tenant_configuration"("tenantId", "namespace");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_configuration_tenantId_namespace_key_key" ON "tenant_configuration"("tenantId", "namespace", "key");
