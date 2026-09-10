-- What kind of work a developer does — DEV, QA or OTH — as stated by an admin.
--
-- SprintIQ cannot observe this. A QA engineer committing test automation and a
-- backend developer look identical in the delivery graph, and inferring the
-- difference from file paths or commit messages would be a guess presented as a
-- fact. So it is an explicit human statement, recorded with who made it.
--
-- Keyed on the canonical developer rather than added as a column on
-- correlation_developer_identity: that table holds one row per SOURCE identity
-- (a github login, a jira account, a bare email) and one person has several, so
-- a role there would be duplicated across rows that could drift apart.
--
-- Purely additive. No existing table is altered and no data is rewritten.
-- CreateTable
CREATE TABLE "developer_role" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "canonicalDeveloperId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "setByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "developer_role_pkey" PRIMARY KEY ("id")
);

-- One role per developer; re-classifying updates the existing row rather than
-- stacking rows nobody can reason about. Absence of a row means UNCLASSIFIED,
-- which is not 'OTH' — the boards render that difference.
-- CreateIndex
CREATE UNIQUE INDEX "developer_role_tenantId_canonicalDeveloperId_key" ON "developer_role"("tenantId", "canonicalDeveloperId");
