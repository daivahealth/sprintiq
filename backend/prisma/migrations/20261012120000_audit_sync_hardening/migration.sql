-- Full branch sweep (audit-sync hardening, spec item 3): tells an audit-log
-- run apart from a full-sweep run. Existing rows are all audit runs.
ALTER TABLE "collectors_github_audit_run" ADD COLUMN "trigger" TEXT NOT NULL DEFAULT 'audit';
