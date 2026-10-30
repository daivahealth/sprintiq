-- Daily digest (2026-10-30): record what started each run, so an unattended
-- 09:30 IST send can be told apart from an admin's manual one. Additive; every
-- existing row was a manual run, which the default records truthfully.
ALTER TABLE "notification_no_commit_run" ADD COLUMN "trigger" TEXT NOT NULL DEFAULT 'manual';
