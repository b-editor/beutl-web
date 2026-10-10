ALTER TABLE "PackageCheckoutAttempt" SET (schema_locked = false);
ALTER TABLE "PackageCheckoutAttempt" ADD COLUMN IF NOT EXISTS "createLeaseToken" STRING;
ALTER TABLE "PackageCheckoutAttempt" ADD COLUMN IF NOT EXISTS "createLeaseExpiresAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "PackageCheckoutAttempt_create_lease_idx" ON "PackageCheckoutAttempt" ("createLeaseExpiresAt");
DROP INDEX IF EXISTS "PackageCheckoutAttempt_recovery_idx";
CREATE INDEX IF NOT EXISTS "PackageCheckoutAttempt_recovery_idx" ON "PackageCheckoutAttempt" ("status", "accountDeletionAt", "recoveryNotBefore", "recoveryLeaseExpiresAt", "createLeaseExpiresAt");
ALTER TABLE "PackageCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "PackageCheckoutAttempt_create_lease_pair_check" CHECK (("createLeaseToken" IS NULL AND "createLeaseExpiresAt" IS NULL) OR ("createLeaseToken" IS NOT NULL AND "createLeaseExpiresAt" IS NOT NULL));
ALTER TABLE "PackageCheckoutAttempt" SET (schema_locked = true);
