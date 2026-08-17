-- Completeness watermark: the point in SOURCE time a connection is known
-- complete through. Distinct from lastSyncAt (when we last called the API) —
-- a connection can reach GitHub every 5 minutes while 80 pages behind.
-- Backfilled as NULL on purpose: existing connections have not established a
-- completeness, and their collectors set it on the next pass that completes.
ALTER TABLE "connections_connection" ADD COLUMN "collectedThroughAt" TIMESTAMP(3);

-- Pending out-of-band sync request ("sync now"). Cleared the moment the
-- connection actually syncs, so a request cannot camp at the head of the sweep.
ALTER TABLE "connections_connection" ADD COLUMN "syncRequestedAt" TIMESTAMP(3);

-- Serves the sweep's query exactly:
--   WHERE "sourceSystem" = $1 AND status = 'active'
--   ORDER BY "syncRequestedAt" DESC NULLS LAST, "lastSyncAt" ASC NULLS FIRST
-- The filter columns lead so they can be probed, and the sort columns carry
-- their own direction and NULLS placement — a plain (syncRequestedAt,
-- lastSyncAt) index matches neither the forward nor the reverse btree scan for
-- this ORDER BY, so Postgres would seq-scan and sort every tick regardless.
CREATE INDEX "connections_connection_sweep_order_idx"
  ON "connections_connection"(
    "sourceSystem",
    "status",
    "syncRequestedAt" DESC NULLS LAST,
    "lastSyncAt" ASC NULLS FIRST
  );
