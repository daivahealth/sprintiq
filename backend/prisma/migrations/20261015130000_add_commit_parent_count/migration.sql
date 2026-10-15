-- Parent count per commit, so merge commits (parentCount > 1) can be excluded
-- from LOC and authorship counts (METRICS.md §0). Nullable: existing rows are
-- unknown until the parent-count reconciler backfills them.
ALTER TABLE "code_commit" ADD COLUMN "parentCount" INTEGER;
