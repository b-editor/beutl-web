-- Bound the lifetime of a durable deletion authorization. An interrupted saga
-- can resume for seven days without the original token, after which the user
-- must explicitly authorize account deletion again.
ALTER TABLE "AccountDeletionIntent"
ADD COLUMN "expiresAt" TIMESTAMP(3);

UPDATE "AccountDeletionIntent"
SET "expiresAt" = "authorizedAt" + INTERVAL '7 days';

ALTER TABLE "AccountDeletionIntent"
ALTER COLUMN "expiresAt" SET NOT NULL;

CREATE INDEX "AccountDeletionIntent_expiresAt_idx"
ON "AccountDeletionIntent"("expiresAt");

-- Restore CockroachDB's schema locks after the paid-AI migration chain has
-- finished evolving every newly created table.
ALTER TABLE "CreditAccount" SET (schema_locked = true);
ALTER TABLE "CreditTransaction" SET (schema_locked = true);
ALTER TABLE "AiJob" SET (schema_locked = true);
ALTER TABLE "Subscription" SET (schema_locked = true);
ALTER TABLE "ProCheckoutAttempt" SET (schema_locked = true);
ALTER TABLE "StripeCreditReversal" SET (schema_locked = true);
ALTER TABLE "AiStorageCleanup" SET (schema_locked = true);
ALTER TABLE "StripeCustomerOwnership" SET (schema_locked = true);
ALTER TABLE "AccountDeletionIntent" SET (schema_locked = true);
