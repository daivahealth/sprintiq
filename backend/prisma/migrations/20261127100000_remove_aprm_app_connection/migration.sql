-- TEMPORARY data fix (2026-11-27): remove the GitHub connection for
-- athmahealth/aprm-app.
--
-- The repository was destroyed on GitHub on 2026-11-26T06:40Z (repo id
-- 1399417367). Its connection stayed `active`, so every poll fails with a
-- 404 and the connection reports `lastError`. The daily commit digest's
-- pipeline gate refuses to name anyone while any active connection is
-- failing, so one dead repo withholds the digest for the whole tenant.
--
-- Scope: only the collector's own state for this repo (the connection, its
-- sync-run history, branch tips and audit push ranges). Collected history
-- (commits, PRs, reviews, raw events) is kept, since lineage stays intact
-- for the work done while the repo existed.
--
-- Data-only, idempotent, and a no-op on any database without this repo.
-- The real fix is repo-lifecycle handling keyed by GitHub repo id
-- (ADR-0015 / Plan B); this migration exists only until that ships.

DELETE FROM "collectors_connection_sync_run"
WHERE "connectionId" IN (
  SELECT "id" FROM "connections_connection"
  WHERE "sourceSystem" = 'github'
    AND ("name" = 'athmahealth/aprm-app'
         OR "config"->>'repoFullName' = 'athmahealth/aprm-app')
);

DELETE FROM "collectors_github_push_range"
WHERE "repoFullName" = 'athmahealth/aprm-app';

DELETE FROM "collectors_github_ref_tip"
WHERE "repoFullName" = 'athmahealth/aprm-app';

DELETE FROM "connections_connection"
WHERE "sourceSystem" = 'github'
  AND ("name" = 'athmahealth/aprm-app'
       OR "config"->>'repoFullName' = 'athmahealth/aprm-app');
