-- An admin statement that overrides what identity resolution concluded about
-- one observed source identity, plus the flag that statement sets.
--
-- Identity resolution is deliberately evidence-only: it merges on a login, a
-- verified email or an unambiguous normalized name, and refuses to guess. That
-- is the right default, and it leaves two residues no evidence can clear:
--
--   1. Split people — a developer who also commits from a personal laptop under
--      a Gmail address, or from a machine whose git config carries an employee
--      number, produces a second entity with no bridge to the first.
--   2. Non-developers — automation the bot heuristics miss, and Jira-only
--      accounts that hold tickets and never commit.
--
-- Only a human can settle either, so this is where a human says it: tenant
-- scoped, carrying who decided and why, changeable without a deploy.
--
-- Applied DURING resolution, which is what makes it durable. resolveTenant()
-- re-derives every identity row from collected commits and PRs on each pass, so
-- a row edited by hand is gone on the next sweep; a row derived through this
-- table survives, including across a full re-collection from empty.
-- CreateTable
CREATE TABLE "correlation_identity_override" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "canonicalDeveloperId" TEXT,
    "reason" TEXT NOT NULL,
    "setByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "correlation_identity_override_pkey" PRIMARY KEY ("id")
);

-- One statement per observed identity; restating it updates the row rather than
-- stacking rows that could disagree about the same person.
-- CreateIndex
CREATE UNIQUE INDEX "correlation_identity_override_tenantId_sourceSystem_sourceK_key" ON "correlation_identity_override"("tenantId", "sourceSystem", "sourceKey");

-- CreateIndex
CREATE INDEX "correlation_identity_override_tenantId_action_idx" ON "correlation_identity_override"("tenantId", "action");

-- Backfills FALSE for every existing row, so nobody is hidden by this migration.
-- An excluded identity stays in the commit and LOC totals and is withheld only
-- from figures that count people — the migration itself changes no number.
-- AlterTable
ALTER TABLE "correlation_developer_identity" ADD COLUMN "excluded" BOOLEAN NOT NULL DEFAULT false;
