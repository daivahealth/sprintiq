-- AlterTable
ALTER TABLE "planning_story" ADD COLUMN     "assigneeLogin" TEXT,
ADD COLUMN     "assigneeName" TEXT,
ADD COLUMN     "epicKey" TEXT,
ADD COLUMN     "parentKey" TEXT,
ADD COLUMN     "priority" TEXT,
ADD COLUMN     "releases" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "sprintExternalId" TEXT;

-- CreateTable
CREATE TABLE "planning_sprint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "projectKey" TEXT NOT NULL,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "goal" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planning_sprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planning_release" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "released" BOOLEAN NOT NULL DEFAULT false,
    "releaseDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planning_release_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "planning_sprint_tenantId_projectKey_state_idx" ON "planning_sprint"("tenantId", "projectKey", "state");

-- CreateIndex
CREATE UNIQUE INDEX "planning_sprint_tenantId_externalId_key" ON "planning_sprint"("tenantId", "externalId");

-- CreateIndex
CREATE INDEX "planning_release_tenantId_projectKey_idx" ON "planning_release"("tenantId", "projectKey");

-- CreateIndex
CREATE UNIQUE INDEX "planning_release_tenantId_projectKey_name_key" ON "planning_release"("tenantId", "projectKey", "name");

-- CreateIndex
CREATE INDEX "planning_story_tenantId_epicKey_idx" ON "planning_story"("tenantId", "epicKey");

-- CreateIndex
CREATE INDEX "planning_story_tenantId_sprintExternalId_idx" ON "planning_story"("tenantId", "sprintExternalId");

