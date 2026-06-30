-- CreateTable
CREATE TABLE "tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'trial',
    "region" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_user" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT,
    "ssoSubject" TEXT,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connections_connection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "secretRef" TEXT,
    "webhookSecretRef" TEXT,
    "syncCursors" JSONB NOT NULL,
    "rateLimitState" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastSyncAt" TIMESTAMP(3),
    "syncLagSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connections_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collectors_raw_event" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "collectionMode" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "envelope" JSONB NOT NULL,
    "processingStatus" TEXT NOT NULL DEFAULT 'received',
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collectors_raw_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planning_story" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'story',
    "status" TEXT NOT NULL,
    "storyPoints" INTEGER,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planning_story_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_pull_request" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "externalNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "baseBranch" TEXT,
    "state" TEXT NOT NULL,
    "authorLogin" TEXT,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "changedFiles" INTEGER NOT NULL DEFAULT 0,
    "commitMessages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "openedAt" TIMESTAMP(3),
    "firstReviewAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "mergedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_pull_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correlation_link" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "edgeType" TEXT NOT NULL,
    "fromType" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toType" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "method" TEXT NOT NULL,
    "evidence" JSONB,
    "sourceEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "correlation_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correlation_orphan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nodeType" TEXT NOT NULL,
    "nodeRef" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "correlation_orphan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metrics_value" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "lineage" JSONB,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metrics_value_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "identity_user_tenantId_idx" ON "identity_user"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "identity_user_tenantId_email_key" ON "identity_user"("tenantId", "email");

-- CreateIndex
CREATE INDEX "connections_connection_tenantId_sourceSystem_idx" ON "connections_connection"("tenantId", "sourceSystem");

-- CreateIndex
CREATE INDEX "collectors_raw_event_tenantId_processingStatus_idx" ON "collectors_raw_event"("tenantId", "processingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "collectors_raw_event_tenantId_idempotencyKey_key" ON "collectors_raw_event"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "audit_log_tenantId_createdAt_idx" ON "audit_log"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "planning_story_tenantId_projectKey_idx" ON "planning_story"("tenantId", "projectKey");

-- CreateIndex
CREATE UNIQUE INDEX "planning_story_tenantId_externalKey_key" ON "planning_story"("tenantId", "externalKey");

-- CreateIndex
CREATE INDEX "code_pull_request_tenantId_repoFullName_idx" ON "code_pull_request"("tenantId", "repoFullName");

-- CreateIndex
CREATE UNIQUE INDEX "code_pull_request_tenantId_repoFullName_externalNumber_key" ON "code_pull_request"("tenantId", "repoFullName", "externalNumber");

-- CreateIndex
CREATE INDEX "correlation_link_tenantId_edgeType_idx" ON "correlation_link"("tenantId", "edgeType");

-- CreateIndex
CREATE INDEX "correlation_orphan_tenantId_nodeType_idx" ON "correlation_orphan"("tenantId", "nodeType");

-- CreateIndex
CREATE INDEX "metrics_value_tenantId_metricKey_scopeType_scopeId_idx" ON "metrics_value"("tenantId", "metricKey", "scopeType", "scopeId");

