ALTER TABLE "TopUpCheckoutResolution" SET (schema_locked = false);
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "operatorUserId" STRING;
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "operatorReason" STRING;
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "operatorEvidence" STRING;
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "operatorActionAt" TIMESTAMP(3);
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "operatorLeaseToken" STRING;
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "operatorLeaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "operatorAbsenceObservedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "TopUpCheckoutResolution_operator_lease_idx" ON "TopUpCheckoutResolution" ("status", "operatorLeaseExpiresAt", "updatedAt");
ALTER TABLE "TopUpCheckoutResolution" ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutResolution_operator_lease_pair_check" CHECK (("operatorLeaseToken" IS NULL AND "operatorLeaseExpiresAt" IS NULL) OR ("operatorLeaseToken" IS NOT NULL AND "operatorLeaseExpiresAt" IS NOT NULL));
ALTER TABLE "TopUpCheckoutResolution" SET (schema_locked = true);

-- A row cannot be terminally refunded while it records only a partial amount.
-- Repair legacy partial rows back to intervention before installing the guard.
ALTER TABLE "TopUpDuplicateRefundAttempt" SET (schema_locked = false);
UPDATE "TopUpDuplicateRefundAttempt"
SET "status" = 'intervention',
    "interventionAt" = COALESCE("interventionAt", CURRENT_TIMESTAMP),
    "lastError" = 'Recorded refunded status did not cover the full amount'
WHERE "status" = 'refunded' AND "refundedAmount" <> "amount";
ALTER TABLE "TopUpDuplicateRefundAttempt"
  ADD CONSTRAINT IF NOT EXISTS "TopUpDuplicateRefundAttempt_refunded_amount_check"
  CHECK ("status" <> 'refunded' OR "refundedAmount" = "amount");
ALTER TABLE "TopUpDuplicateRefundAttempt" SET (schema_locked = true);

-- The main attempt has the same invariant: a refunded terminal state must
-- represent the full target amount with nothing still pending. Requeue legacy
-- partial rows so the canonical refund worker can reconcile Stripe again.
ALTER TABLE "TopUpCheckoutAttempt" SET (schema_locked = false);
UPDATE "TopUpCheckoutAttempt"
SET "status" = 'refund_failed',
    "refundNotBefore" = CURRENT_TIMESTAMP,
    "refundLastError" = 'Recorded refunded status did not cover the full target',
    "refundInterventionAt" = NULL
WHERE "status" = 'refunded'
  AND (
    "refundTargetAmount" IS NULL OR
    "refundTargetAmount" <= 0 OR
    "refundSucceededAmount" <> "refundTargetAmount" OR
    "refundPendingAmount" <> 0
  );
ALTER TABLE "TopUpCheckoutAttempt"
  ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutAttempt_refunded_amount_check"
  CHECK (
    "status" <> 'refunded' OR (
      "refundTargetAmount" IS NOT NULL AND
      "refundTargetAmount" > 0 AND
      "refundSucceededAmount" = "refundTargetAmount" AND
      "refundPendingAmount" = 0
    )
  );
ALTER TABLE "TopUpCheckoutAttempt" SET (schema_locked = true);

-- Every legacy detached marker must have a durable, globally actionable
-- resolution row. This is idempotent and preserves any known PaymentIntent as
-- evidence instead of silently dropping it.
INSERT INTO "TopUpCheckoutResolution" (
  "id", "topUpAttemptId", "ownerUserId", "stripeCustomerId", "billingOfferId",
  "canonicalSessionId", "canonicalPaymentIntentId", "expectedPaymentIntentIds",
  "status", "revision", "lastError", "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), a."id", a."ownerUserId", a."stripeCustomerId", a."billingOfferId",
       a."stripeCheckoutSessionId", a."stripePaymentIntentId", '[]',
       'intervention', 0, COALESCE(a."recoveryLastError", 'Legacy top-up recovery requires operator intervention'),
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "TopUpCheckoutAttempt" a
LEFT JOIN "TopUpCheckoutResolution" r ON r."topUpAttemptId" = a."id"
WHERE a."recoveryInterventionAt" IS NOT NULL AND r."id" IS NULL;
