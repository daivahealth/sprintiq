-- An admin-entered statement that a developer should not be listed among the
-- Watchlist's "go ask about this person" buckets: approved leave, a new joiner,
-- a secondment. SprintIQ has no HR feed, so this is a human judgement, recorded
-- with who made it and when it lapses — never inferred.
--
-- Note this suppresses ONE thing: appearing in an attention bucket. The
-- developer keeps counting in every commit, PR and metric figure, and the board
-- still discloses how many people are excluded and why.
-- CreateTable
CREATE TABLE "watchlist_exclusion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "canonicalDeveloperId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "watchlist_exclusion_pkey" PRIMARY KEY ("id")
);

-- One live exclusion per developer; re-excluding updates the existing row
-- rather than stacking overlapping ones nobody can reason about.
-- CreateIndex
CREATE UNIQUE INDEX "watchlist_exclusion_tenantId_canonicalDeveloperId_key" ON "watchlist_exclusion"("tenantId", "canonicalDeveloperId");

-- The board reads "exclusions live right now", i.e. filtered on expiry.
-- CreateIndex
CREATE INDEX "watchlist_exclusion_tenantId_expiresAt_idx" ON "watchlist_exclusion"("tenantId", "expiresAt");
