-- AlterTable
ALTER TABLE "code_pr_review" ADD COLUMN     "isBot" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "code_pr_review" ADD COLUMN     "commentsCounted" BOOLEAN NOT NULL DEFAULT false;

-- Backfill isBot for reviews already collected, from GitHub's own login
-- convention for App-based bots (`name[bot]`). Deterministic and needs no API
-- call. User-account automation (a service account with an ordinary login) is
-- NOT caught by this and is re-classified on the next collection, when
-- GitHub's authoritative `user.type` is read.
UPDATE "code_pr_review" SET "isBot" = true WHERE "reviewerLogin" LIKE '%[bot]';

-- The review metrics filter on this constantly.
CREATE INDEX "code_pr_review_tenantId_isBot_idx" ON "code_pr_review"("tenantId", "isBot");
