-- The assignee's Atlassian account email, when Jira discloses it — the strong
-- rung of the Jira<->GitHub identity bridge (DATA-MODEL.md 3.1). People commit
-- under their corporate address and hold their Atlassian account under the same
-- one, so an exact match beats the display-name inference it supersedes.
--
-- Nullable and routinely null: Jira Cloud omits `emailAddress` unless the
-- instance's user-profile visibility permits it. Null means "Jira would not
-- tell us", never "no email" — matching falls back to the name rungs.
--
-- Existing rows stay null until the reconciler re-walks them: the Jira poller
-- advances on an `updated` cursor, so every already-collected story sits behind
-- the watermark and would never be revisited on its own.
-- AlterTable
ALTER TABLE "planning_story" ADD COLUMN "assigneeEmail" TEXT;

-- The bridge looks up assignees BY email, so it is a query predicate.
-- Deliberately NOT a partial index despite the column being mostly null:
-- Prisma's schema language cannot express a WHERE clause, so a partial index
-- here would be invisible to schema.prisma and dropped by the next
-- `migrate dev`. A plain index that both sides agree on beats a cleverer one
-- that drifts.
-- CreateIndex
CREATE INDEX "planning_story_tenantId_assigneeEmail_idx"
  ON "planning_story"("tenantId", "assigneeEmail");
