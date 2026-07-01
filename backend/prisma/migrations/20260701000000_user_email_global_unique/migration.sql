-- DropIndex
DROP INDEX "identity_user_tenantId_email_key";

-- CreateIndex
CREATE UNIQUE INDEX "identity_user_email_key" ON "identity_user"("email");

