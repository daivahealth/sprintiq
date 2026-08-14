-- CreateTable
CREATE TABLE "correlation_developer_identity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceLogin" TEXT,
    "email" TEXT,
    "name" TEXT,
    "canonicalDeveloperId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "method" TEXT NOT NULL,
    "evidence" JSONB,
    "linkedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "correlation_developer_identity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "correlation_developer_identity_tenantId_sourceSystem_sourceKey_key" ON "correlation_developer_identity"("tenantId", "sourceSystem", "sourceKey");

-- CreateIndex
CREATE INDEX "correlation_developer_identity_tenantId_canonicalDeveloperId_idx" ON "correlation_developer_identity"("tenantId", "canonicalDeveloperId");

-- Commit reads now filter on the git author email as well as the login, so that
-- a commit GitHub could not attribute is still reachable through its identity.
CREATE INDEX IF NOT EXISTS "code_commit_tenantId_authorEmail_committedAt_idx" ON "code_commit"("tenantId", "authorEmail", "committedAt");
