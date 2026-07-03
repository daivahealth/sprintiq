-- CreateTable
CREATE TABLE "code_commit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "authorLogin" TEXT,
    "authorName" TEXT,
    "authorEmail" TEXT,
    "authoredAt" TIMESTAMP(3) NOT NULL,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "filesChanged" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_commit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "code_commit_tenantId_authorLogin_authoredAt_idx" ON "code_commit"("tenantId", "authorLogin", "authoredAt");

-- CreateIndex
CREATE INDEX "code_commit_tenantId_repoFullName_authoredAt_idx" ON "code_commit"("tenantId", "repoFullName", "authoredAt");

-- CreateIndex
CREATE UNIQUE INDEX "code_commit_tenantId_repoFullName_sha_key" ON "code_commit"("tenantId", "repoFullName", "sha");

