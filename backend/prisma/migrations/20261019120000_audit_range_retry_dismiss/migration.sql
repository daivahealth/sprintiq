-- Audit-route robustness (2026-10-19): retry backoff and admin dismissal of
-- push ranges. Additive; nullable columns, no backfill needed.
ALTER TABLE "collectors_github_push_range" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);
ALTER TABLE "collectors_github_push_range" ADD COLUMN "dismissedAt" TIMESTAMP(3);
ALTER TABLE "collectors_github_push_range" ADD COLUMN "dismissedByUserId" TEXT;
ALTER TABLE "collectors_github_push_range" ADD COLUMN "dismissedReason" TEXT;
