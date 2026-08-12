-- Refund-required top-ups outlive the account that initiated Checkout. Keep
-- their retry schedule, exclusive lease, and intervention state in the same
-- durable row so a Worker restart cannot lose or duplicate money movement.
ALTER TABLE "TopUpCheckoutAttempt" SET (schema_locked = false);

ALTER TABLE "TopUpCheckoutAttempt"
ADD COLUMN "refundStatusObservedAt" TIMESTAMP(3);
ALTER TABLE "TopUpCheckoutAttempt"
ADD COLUMN "refundNotBefore" TIMESTAMP(3);
ALTER TABLE "TopUpCheckoutAttempt"
ADD COLUMN "refundLeaseToken" STRING;
ALTER TABLE "TopUpCheckoutAttempt"
ADD COLUMN "refundLeaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "TopUpCheckoutAttempt"
ADD COLUMN "refundAttempts" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "TopUpCheckoutAttempt"
ADD COLUMN "refundLastError" STRING;
ALTER TABLE "TopUpCheckoutAttempt"
ADD COLUMN "refundInterventionAt" TIMESTAMP(3);

-- Existing non-terminal refunds become immediately eligible for the new
-- scheduled processor. Terminal rows deliberately retain a NULL schedule.
UPDATE "TopUpCheckoutAttempt"
SET "refundNotBefore" = CURRENT_TIMESTAMP
WHERE "status" IN (
    'refund_required', 'refund_pending', 'refund_failed'
);

ALTER TABLE "TopUpCheckoutAttempt"
DROP CONSTRAINT "TopUpCheckoutAttempt_status_check";
ALTER TABLE "TopUpCheckoutAttempt"
ADD CONSTRAINT "TopUpCheckoutAttempt_status_check"
CHECK ("status" IN (
    'open', 'payment_pending', 'fulfilled', 'refund_required',
    'refund_pending', 'refund_failed', 'refunded', 'refund_not_required'
));
ALTER TABLE "TopUpCheckoutAttempt"
ADD CONSTRAINT "TopUpCheckoutAttempt_refund_attempts_check"
CHECK ("refundAttempts" >= 0);
ALTER TABLE "TopUpCheckoutAttempt"
ADD CONSTRAINT "TopUpCheckoutAttempt_refund_lease_pair_check"
CHECK (
    ("refundLeaseToken" IS NULL AND "refundLeaseExpiresAt" IS NULL)
    OR
    ("refundLeaseToken" IS NOT NULL AND "refundLeaseExpiresAt" IS NOT NULL)
);

CREATE INDEX "TopUpCheckoutAttempt_status_refundNotBefore_refundLeaseExpiresAt_idx"
ON "TopUpCheckoutAttempt"(
    "status", "refundNotBefore", "refundLeaseExpiresAt"
);

ALTER TABLE "TopUpCheckoutAttempt" SET (schema_locked = true);
