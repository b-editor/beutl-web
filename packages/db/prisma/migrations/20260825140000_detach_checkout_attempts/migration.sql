ALTER TABLE "ProCheckoutAttempt" SET (schema_locked = false);
ALTER TABLE "ProCheckoutAttempt" ADD COLUMN IF NOT EXISTS "customerId" STRING;
ALTER TABLE "ProCheckoutAttempt" ADD COLUMN IF NOT EXISTS "accountDeletionAt" TIMESTAMP(3);
ALTER TABLE "ProCheckoutAttempt" ADD COLUMN IF NOT EXISTS "paramsJson" STRING;
ALTER TABLE "ProCheckoutAttempt" ADD COLUMN IF NOT EXISTS "recoveryLeaseToken" STRING;
ALTER TABLE "ProCheckoutAttempt" ADD COLUMN IF NOT EXISTS "recoveryLeaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "ProCheckoutAttempt" ADD COLUMN IF NOT EXISTS "recoveryAttempts" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "ProCheckoutAttempt" ADD COLUMN IF NOT EXISTS "recoveryLastError" STRING;
ALTER TABLE "ProCheckoutAttempt" ADD COLUMN IF NOT EXISTS "recoveryNotBefore" TIMESTAMP(3);
ALTER TABLE "ProCheckoutAttempt" ADD COLUMN IF NOT EXISTS "recoveryInterventionAt" TIMESTAMP(3);
ALTER TABLE "ProCheckoutAttempt" ADD COLUMN IF NOT EXISTS "recoveryCompletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "ProCheckoutAttempt_recovery_idx" ON "ProCheckoutAttempt" ("accountDeletionAt", "stripeCheckoutSessionId", "recoveryNotBefore", "recoveryLeaseExpiresAt", "recoveryInterventionAt");
ALTER TABLE "ProCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "ProCheckoutAttempt_recovery_attempts_check" CHECK ("recoveryAttempts" >= 0);
ALTER TABLE "ProCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "ProCheckoutAttempt_recovery_lease_pair_check" CHECK (("recoveryLeaseToken" IS NULL AND "recoveryLeaseExpiresAt" IS NULL) OR ("recoveryLeaseToken" IS NOT NULL AND "recoveryLeaseExpiresAt" IS NOT NULL));
UPDATE "ProCheckoutAttempt" AS attempt
SET "customerId" = customer."stripeId"
FROM "Customer" AS customer
WHERE customer."userId" = attempt."userId"
  AND attempt."customerId" IS NULL;
UPDATE "ProCheckoutAttempt"
SET "accountDeletionAt" = CURRENT_TIMESTAMP
WHERE "stripeCheckoutSessionId" IS NOT NULL
  AND "customerId" IS NULL;
-- Bound attempts without a Customer mapping cannot be safely detached. Abort
-- this migration instead of allowing a payable Session to become orphaned.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "ProCheckoutAttempt" WHERE "stripeCheckoutSessionId" IS NULL AND "paramsJson" IS NULL) THEN
    RAISE EXCEPTION 'ProCheckoutAttempt has an unbound legacy row without paramsJson; recover by Stripe metadata before applying this migration';
  END IF;
  IF EXISTS (SELECT 1 FROM "ProCheckoutAttempt" WHERE "stripeCheckoutSessionId" IS NOT NULL AND "customerId" IS NULL) THEN
    RAISE EXCEPTION 'ProCheckoutAttempt has a bound Session without a Customer mapping';
  END IF;
END $$;
-- Rows without a local Customer mapping retain a nullable identity and are
-- blocked for intervention; inventing a Stripe Customer would lose recovery
-- ownership. Bound rows are backfilled above.
ALTER TABLE "ProCheckoutAttempt" DROP CONSTRAINT IF EXISTS "ProCheckoutAttempt_userId_fkey";
ALTER TABLE "ProCheckoutAttempt" SET (schema_locked = true);
