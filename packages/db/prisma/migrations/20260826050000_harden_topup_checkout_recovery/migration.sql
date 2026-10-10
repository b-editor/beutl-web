-- A nullable unique owner slot makes "one unresolved top-up" a database
-- invariant. The persisted Checkout key and create lease keep Stripe retries
-- stable across response loss and concurrent Server Action invocations.
ALTER TABLE "TopUpCheckoutAttempt" SET (schema_locked = false);

ALTER TABLE "TopUpCheckoutAttempt" ADD COLUMN IF NOT EXISTS "activeOwnerKey" STRING;
ALTER TABLE "TopUpCheckoutAttempt" ADD COLUMN IF NOT EXISTS "checkoutKey" STRING;
ALTER TABLE "TopUpCheckoutAttempt" ADD COLUMN IF NOT EXISTS "createLeaseToken" STRING;
ALTER TABLE "TopUpCheckoutAttempt" ADD COLUMN IF NOT EXISTS "createLeaseExpiresAt" TIMESTAMP(3);

UPDATE "TopUpCheckoutAttempt"
SET "checkoutKey" = 'ai-top-up-checkout:' || "id"
WHERE "checkoutKey" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "TopUpCheckoutAttempt"
    WHERE "checkoutKey" IS NULL
  ) OR EXISTS (
    SELECT "checkoutKey"
    FROM "TopUpCheckoutAttempt"
    GROUP BY "checkoutKey"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'TopUpCheckoutAttempt checkout keys are missing or duplicated';
  END IF;
END
$$;

ALTER TABLE "TopUpCheckoutAttempt" ALTER COLUMN "checkoutKey" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "TopUpCheckoutAttempt_checkoutKey_key"
  ON "TopUpCheckoutAttempt" ("checkoutKey");

-- Backfill only owners with one unresolved row. Multiple legacy rows require
-- exhaustive Stripe reconciliation before an active row can be selected.
UPDATE "TopUpCheckoutAttempt"
SET "activeOwnerKey" = "ownerUserId"
WHERE "id" IN (
  SELECT min("id")
  FROM "TopUpCheckoutAttempt"
  WHERE "status" NOT IN ('fulfilled', 'refunded', 'refund_not_required')
  GROUP BY "ownerUserId"
  HAVING count(*) = 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "TopUpCheckoutAttempt_activeOwnerKey_key"
  ON "TopUpCheckoutAttempt" ("activeOwnerKey");
CREATE INDEX IF NOT EXISTS "TopUpCheckoutAttempt_unbound_recovery_idx"
  ON "TopUpCheckoutAttempt" (
    "status",
    "stripeCheckoutSessionId",
    "recoveryNotBefore",
    "recoveryLeaseExpiresAt",
    "createLeaseExpiresAt",
    "recoveryInterventionAt"
  );
ALTER TABLE "TopUpCheckoutAttempt"
  ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutAttempt_create_lease_pair_check"
  CHECK (
    ("createLeaseToken" IS NULL AND "createLeaseExpiresAt" IS NULL)
    OR
    ("createLeaseToken" IS NOT NULL AND "createLeaseExpiresAt" IS NOT NULL)
  );

ALTER TABLE "TopUpCheckoutAttempt" DROP CONSTRAINT IF EXISTS "TopUpCheckoutAttempt_status_check";
ALTER TABLE "TopUpCheckoutAttempt"
  ADD CONSTRAINT "TopUpCheckoutAttempt_status_check"
  CHECK ("status" IN (
    'open', 'payment_pending', 'fulfilled', 'expired', 'refund_required',
    'refund_pending', 'refund_failed', 'refunded', 'refund_not_required'
  ));

ALTER TABLE "TopUpCheckoutAttempt" SET (schema_locked = true);

-- Intervention rows remain auditable while periodic canonical Stripe reads can
-- prove that a delayed refund eventually settled.
ALTER TABLE "TopUpDuplicateRefundAttempt" SET (schema_locked = false);
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "interventionAt" TIMESTAMP(3);
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "lastCanonicalCheckAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "TopUpDuplicateRefundAttempt_due_idx"
  ON "TopUpDuplicateRefundAttempt" ("status", "notBefore", "leaseExpiresAt");
ALTER TABLE "TopUpDuplicateRefundAttempt" SET (schema_locked = true);

ALTER TABLE "TopUpCheckoutResolution" SET (schema_locked = false);
ALTER TABLE "TopUpCheckoutResolution"
  ADD COLUMN IF NOT EXISTS "canonicalPaymentIntentId" STRING;
ALTER TABLE "TopUpCheckoutResolution" SET (schema_locked = true);
