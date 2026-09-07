-- Sprint Health detail view needs release dates Jira won't reliably hold and
-- a way to tell "found in" from "fixed in" on a work item. Both gaps are
-- closed with plain nullable/defaulted columns: an unmigrated or
-- not-yet-re-walked row renders as unknown on the board, never as a zero the
-- dashboard would present as fact.
--
-- Jira version id, for the version projection (Task 4) to key off of instead
-- of the mutable (tenantId, projectKey, name) tuple. Null for a release first
-- seen only as a bare fixVersion name on an issue; filled in once the
-- `planning.version.upserted` event for it arrives.
-- AlterTable
ALTER TABLE "planning_release" ADD COLUMN "externalId" TEXT;

-- Jira's `startDate` on the version.
-- AlterTable
ALTER TABLE "planning_release" ADD COLUMN "startAt" TIMESTAMP(3);

-- Jira's `archived` flag on the version.
-- AlterTable
ALTER TABLE "planning_release" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;

-- The date this release was PLANNED for — user input, because Jira overwrites
-- `releaseDate` on release and destroys the plan. Null means nobody has
-- recorded one, and lateness is then not computed at all (Task 10/11).
-- AlterTable
ALTER TABLE "planning_release" ADD COLUMN "plannedReleaseAt" TIMESTAMP(3);

-- Who recorded the planned date, and when. A human judgement carries a name.
-- AlterTable
ALTER TABLE "planning_release" ADD COLUMN "plannedSetByUserId" TEXT;
ALTER TABLE "planning_release" ADD COLUMN "plannedSetAt" TIMESTAMP(3);

-- Jira's `versions` — Affects Version/s, i.e. where the defect was FOUND.
-- Distinct from `releases` (fixVersions), which is where it will be fixed.
-- "Bugs logged against RC1" is this field; using fixVersions would answer a
-- different question while looking like this one. Empty (not null, matching
-- the existing `releases` column) on items collected before this field was
-- requested from Jira, until they are re-walked (Task 5).
-- AlterTable
ALTER TABLE "planning_story" ADD COLUMN "affectsReleases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
