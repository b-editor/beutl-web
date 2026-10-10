-- A refund is complete only after Stripe has returned the entire captured
-- PaymentIntent amount. Persist canonical aggregates so partial and multiple
-- refunds cannot prematurely terminalize a top-up attempt.
ALTER TABLE "TopUpCheckoutAttempt" SET (schema_locked = false);

ALTER TABLE "TopUpCheckoutAttempt"
ADD COLUMN "refundTargetAmount" INT4;
ALTER TABLE "TopUpCheckoutAttempt"
ADD COLUMN "refundSucceededAmount" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "TopUpCheckoutAttempt"
ADD COLUMN "refundPendingAmount" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "TopUpCheckoutAttempt"
ADD COLUMN "refundCurrency" STRING;

ALTER TABLE "TopUpCheckoutAttempt"
ADD CONSTRAINT "TopUpCheckoutAttempt_refund_amounts_check"
CHECK (
    ("refundTargetAmount" IS NULL OR "refundTargetAmount" >= 0)
    AND "refundSucceededAmount" >= 0
    AND "refundPendingAmount" >= 0
);

ALTER TABLE "TopUpCheckoutAttempt" SET (schema_locked = true);

-- Entitlement holds are scoped to the invoice period and carry the canonical
-- payment/reversal amounts. Nullable columns keep this forward migration safe
-- for any holds written by an older application during rollout.
ALTER TABLE "SubscriptionEntitlementHold" SET (schema_locked = false);

ALTER TABLE "SubscriptionEntitlementHold"
ADD COLUMN "stripeInvoiceId" STRING;
ALTER TABLE "SubscriptionEntitlementHold"
ADD COLUMN "billingPeriodStart" TIMESTAMP(3);
ALTER TABLE "SubscriptionEntitlementHold"
ADD COLUMN "billingPeriodEnd" TIMESTAMP(3);
ALTER TABLE "SubscriptionEntitlementHold"
ADD COLUMN "paymentAmount" INT4;
ALTER TABLE "SubscriptionEntitlementHold"
ADD COLUMN "reversalAmount" INT4;
ALTER TABLE "SubscriptionEntitlementHold"
ADD COLUMN "currency" STRING;
ALTER TABLE "SubscriptionEntitlementHold"
ADD COLUMN "stripeCanonicalObservedAt" TIMESTAMP(3);

-- The billing cutover pauses writes while this migration is applied. Holds
-- created by the pre-period application therefore cannot be backfilled from a
-- trustworthy local source. Fail open for those legacy rows instead of
-- allowing their null period to suspend every future paid period.
UPDATE "SubscriptionEntitlementHold"
SET
    "active" = false,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "active" = true
  AND (
      "billingPeriodStart" IS NULL
      OR "billingPeriodEnd" IS NULL
      OR "paymentAmount" IS NULL
      OR "reversalAmount" IS NULL
  );

ALTER TABLE "SubscriptionEntitlementHold"
ADD CONSTRAINT "SubscriptionEntitlementHold_period_check"
CHECK (
    ("billingPeriodStart" IS NULL AND "billingPeriodEnd" IS NULL)
    OR (
        "billingPeriodStart" IS NOT NULL
        AND "billingPeriodEnd" IS NOT NULL
        AND "billingPeriodStart" < "billingPeriodEnd"
    )
);
ALTER TABLE "SubscriptionEntitlementHold"
ADD CONSTRAINT "SubscriptionEntitlementHold_amounts_check"
CHECK (
    ("paymentAmount" IS NULL AND "reversalAmount" IS NULL)
    OR (
        "paymentAmount" IS NOT NULL
        AND "paymentAmount" > 0
        AND "reversalAmount" IS NOT NULL
        AND "reversalAmount" >= 0
    )
);
ALTER TABLE "SubscriptionEntitlementHold"
ADD CONSTRAINT "SubscriptionEntitlementHold_active_canonical_check"
CHECK (
    NOT "active"
    OR (
        "stripeInvoiceId" IS NOT NULL
        AND "billingPeriodStart" IS NOT NULL
        AND "billingPeriodEnd" IS NOT NULL
        AND "paymentAmount" IS NOT NULL
        AND "reversalAmount" IS NOT NULL
        AND "reversalAmount" >= "paymentAmount"
        AND "currency" IS NOT NULL
    )
);

ALTER TABLE "SubscriptionEntitlementHold" SET (schema_locked = true);

-- Superseded Pro Checkout compensation must survive request crashes and Stripe
-- timeouts. One row owns cancellation and full-refund reconciliation for each
-- paid PaymentIntent (or a cancellation-only Checkout when no payment exists).
CREATE TABLE "BillingRefundAttempt" (
    "id" STRING NOT NULL DEFAULT gen_random_uuid(),
    "disposition" STRING NOT NULL,
    "sourceKey" STRING NOT NULL,
    "stripeCustomerId" STRING NOT NULL,
    "stripeCheckoutSessionId" STRING NOT NULL,
    "stripeSubscriptionId" STRING NOT NULL,
    "stripeInvoiceId" STRING,
    "stripePaymentIntentId" STRING,
    "status" STRING NOT NULL,
    "cancellationCompletedAt" TIMESTAMP(3),
    "targetAmount" INT4,
    "succeededAmount" INT4 NOT NULL DEFAULT 0,
    "pendingAmount" INT4 NOT NULL DEFAULT 0,
    "currency" STRING,
    "refundId" STRING,
    "refundStatus" STRING,
    "refundStatusObservedAt" TIMESTAMP(3),
    "notBefore" TIMESTAMP(3),
    "leaseToken" STRING,
    "leaseExpiresAt" TIMESTAMP(3),
    "attempts" INT4 NOT NULL DEFAULT 0,
    "lastError" STRING,
    "interventionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingRefundAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillingRefundAttempt_status_check"
        CHECK ("status" IN (
            'required', 'refund_pending', 'refunded',
            'no_refund_required', 'intervention_required'
        )),
    CONSTRAINT "BillingRefundAttempt_amounts_check"
        CHECK (
            ("targetAmount" IS NULL OR "targetAmount" >= 0)
            AND "succeededAmount" >= 0
            AND "pendingAmount" >= 0
        ),
    CONSTRAINT "BillingRefundAttempt_attempts_check"
        CHECK ("attempts" >= 0),
    CONSTRAINT "BillingRefundAttempt_lease_pair_check"
        CHECK (
            ("leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)
            OR
            ("leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
    )
);

ALTER TABLE "BillingRefundAttempt" SET (schema_locked = false);

CREATE UNIQUE INDEX "BillingRefundAttempt_sourceKey_key"
ON "BillingRefundAttempt"("sourceKey");
CREATE UNIQUE INDEX "BillingRefundAttempt_stripePaymentIntentId_key"
ON "BillingRefundAttempt"("stripePaymentIntentId");
CREATE INDEX "BillingRefundAttempt_status_notBefore_leaseExpiresAt_idx"
ON "BillingRefundAttempt"("status", "notBefore", "leaseExpiresAt");
CREATE INDEX "BillingRefundAttempt_stripeCheckoutSessionId_idx"
ON "BillingRefundAttempt"("stripeCheckoutSessionId");

ALTER TABLE "BillingRefundAttempt" SET (schema_locked = true);
