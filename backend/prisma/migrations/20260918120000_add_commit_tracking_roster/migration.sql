-- The editable roster of developers whose daily activity is tracked by the
-- digest notification.
--
-- Data rather than a code constant: an admin adds a new joiner without a deploy,
-- and the entry carries the name of whoever added it.
--
-- The "addedAs" field keeps the string exactly as it was ADDED. An entry whose
-- identity never resolved stays displayable and diagnosable instead of reading
-- as a developer who did nothing — without this column, the two are
-- indistinguishable, and one of them is a false accusation.
--
-- Soft delete via "active" flag so removing someone from the roster is a
-- recorded act, not a gap.
-- CreateTable
CREATE TABLE "notification_tracked_developer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "canonicalDeveloperId" TEXT NOT NULL,
    "addedAs" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_tracked_developer_pkey" PRIMARY KEY ("id")
);

-- One row per reported day: what was evaluated, who was named, what was
-- delivered. Lineage for a message that names people — "Why was I on Tuesday's
-- list?" must be answerable after the fact.
--
-- The (tenantId, reportedDay) unique constraint is the idempotency primitive:
-- NotificationsService.runNoCommitDigest claims this row with an INSERT
-- BEFORE posting to Teams, and a losing concurrent INSERT (unique-violation
-- P2002) means another runner already owns this day and returns without
-- posting. That claim-before-post ordering is what makes a restart, a
-- redeploy, or a role-ungated cron firing on multiple pods unable to
-- double-post one day's list — the constraint alone does nothing if the row
-- is only written after the POST, which is what an upsert-after-send does.
--
-- The "incomplete" column holds developers withheld from the list because
-- their commit data for the day was incomplete — deliberately distinct from
-- being inactive. They are reported in the record, never counted as inactive.
-- CreateTable
CREATE TABLE "notification_no_commit_run" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportedDay" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "rosterCount" INTEGER NOT NULL,
    "flaggedCount" INTEGER NOT NULL,
    "flagged" JSONB NOT NULL,
    "unresolved" JSONB NOT NULL,
    "incomplete" JSONB NOT NULL,
    "detail" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_no_commit_run_pkey" PRIMARY KEY ("id")
);

-- One roster entry per developer; re-adding updates the existing row rather
-- than stacking rows nobody can reason about.
-- CreateIndex
CREATE UNIQUE INDEX "notification_tracked_developer_tenantId_canonicalDeveloperId_key" ON "notification_tracked_developer"("tenantId", "canonicalDeveloperId");

-- The digest queries the roster filtering on "active = true", so fast lookup
-- on (tenantId, active) is essential.
-- CreateIndex
CREATE INDEX "notification_tracked_developer_tenantId_active_idx" ON "notification_tracked_developer"("tenantId", "active");

-- The idempotency key: one run record per (tenant, reported day). This is what
-- stops restarts and redeploys from double-posting the same list of names to
-- the same channel.
-- CreateIndex
CREATE UNIQUE INDEX "notification_no_commit_run_tenantId_reportedDay_key" ON "notification_no_commit_run"("tenantId", "reportedDay");

-- The digest job queries runs by when they were created, most recent first, to
-- find today's (or yesterday's) record before deciding whether to send another.
-- CreateIndex
CREATE INDEX "notification_no_commit_run_tenantId_createdAt_idx" ON "notification_no_commit_run"("tenantId", "createdAt");
