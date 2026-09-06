-- Forward-only repair for databases that already ran the initial package
-- attempt migration before recoveryNotBefore was introduced.
ALTER TABLE "PackageCheckoutAttempt" SET (schema_locked = false);
ALTER TABLE "PackageCheckoutAttempt" ADD COLUMN IF NOT EXISTS "recoveryNotBefore" TIMESTAMP(3);
DROP INDEX IF EXISTS "PackageCheckoutAttempt_recovery_idx";
CREATE INDEX "PackageCheckoutAttempt_recovery_idx" ON "PackageCheckoutAttempt" ("status", "accountDeletionAt", "recoveryNotBefore", "recoveryLeaseExpiresAt");
ALTER TABLE "PackageCheckoutAttempt" SET (schema_locked = true);
