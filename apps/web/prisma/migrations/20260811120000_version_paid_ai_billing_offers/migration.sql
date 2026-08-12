-- Forward-only preflight: if this migration is ever applied to a database
-- where the previous customer uniqueness migration did not complete, fail
-- before creating paid-AI billing state. This cannot recover owner evidence
-- discarded by an already-applied migration; runtime code therefore still
-- requires Stripe metadata for every privileged legacy-customer operation.
CREATE TABLE "_PaidAiStripeCustomerOwnerPreflight" (
    "stripeId" STRING NOT NULL,
    "ownerCount" INT8 NOT NULL,

    CONSTRAINT "_PaidAiStripeCustomerOwnerPreflight_pkey"
        PRIMARY KEY ("stripeId"),
    CONSTRAINT "_PaidAiStripeCustomerOwnerPreflight_single_owner_check"
        CHECK ("ownerCount" = 1)
);
INSERT INTO "_PaidAiStripeCustomerOwnerPreflight" ("stripeId", "ownerCount")
SELECT "stripeId", count(*)
FROM "Customer"
GROUP BY "stripeId"
HAVING count(*) > 1;
DROP TABLE "_PaidAiStripeCustomerOwnerPreflight";

-- A bound legacy Pro attempt is a live Stripe handle, not disposable cache.
-- SQL cannot expire Checkout Sessions or refund a Session that completed while
-- this deploy was waiting. Fail before offer-versioning changes so operators
-- must reconcile every bound Session in Stripe and remove its row explicitly.
CREATE TABLE "_BoundLegacyProCheckoutAttemptPreflight" (
    "userId" STRING NOT NULL,
    "stripeCheckoutSessionId" STRING,

    CONSTRAINT "_BoundLegacyProCheckoutAttemptPreflight_pkey"
        PRIMARY KEY ("userId"),
    CONSTRAINT "_BoundLegacyProCheckoutAttemptPreflight_unbound_check"
        CHECK ("stripeCheckoutSessionId" IS NULL)
);
INSERT INTO "_BoundLegacyProCheckoutAttemptPreflight" (
    "userId",
    "stripeCheckoutSessionId"
)
SELECT "userId", "stripeCheckoutSessionId"
FROM "ProCheckoutAttempt"
WHERE "stripeCheckoutSessionId" IS NOT NULL;
DROP TABLE "_BoundLegacyProCheckoutAttemptPreflight";

-- Stripe Price IDs are immutable offer identities. Keep every activated offer
-- so renewals and reversals remain valid after checkout rotates to a new Price.
CREATE TABLE "BillingOffer" (
    "id" STRING NOT NULL DEFAULT gen_random_uuid(),
    "kind" STRING NOT NULL,
    "stripePriceId" STRING NOT NULL,
    "stripeProductId" STRING NOT NULL,
    "unitAmount" INT4 NOT NULL,
    "currency" STRING NOT NULL,
    "creditAmount" INT4,
    "recurringInterval" STRING,
    "recurringIntervalCount" INT4,
    "checkoutEnabled" BOOL NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingOffer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillingOffer_kind_check"
        CHECK ("kind" IN ('pro', 'top_up')),
    CONSTRAINT "BillingOffer_terms_check"
        CHECK (
            ("kind" = 'pro'
             AND "creditAmount" IS NULL
             AND "recurringInterval" IS NOT NULL
             AND "recurringInterval" = 'month'
             AND "recurringIntervalCount" IS NOT NULL
             AND "recurringIntervalCount" = 1)
            OR
            ("kind" = 'top_up'
             AND "creditAmount" IS NOT NULL
             AND "creditAmount" > 0
             AND "recurringInterval" IS NULL
             AND "recurringIntervalCount" IS NULL)
        ),
    CONSTRAINT "BillingOffer_unitAmount_check" CHECK ("unitAmount" > 0)
);

-- This CockroachDB database creates new tables with schema locking enabled.
-- Unlock while indexes and foreign keys are installed, then relock below.
ALTER TABLE "BillingOffer" SET (schema_locked = false);

CREATE UNIQUE INDEX "BillingOffer_stripePriceId_key"
ON "BillingOffer"("stripePriceId");
CREATE INDEX "BillingOffer_kind_checkoutEnabled_idx"
ON "BillingOffer"("kind", "checkoutEnabled");

ALTER TABLE "Subscription" SET (schema_locked = false);
ALTER TABLE "CreditTransaction" SET (schema_locked = false);
ALTER TABLE "ProCheckoutAttempt" SET (schema_locked = false);

ALTER TABLE "Subscription" ADD COLUMN "billingOfferId" STRING;
ALTER TABLE "CreditTransaction" ADD COLUMN "billingOfferId" STRING;
ALTER TABLE "CreditTransaction" ADD COLUMN "topUpCheckoutAttemptId" STRING;

-- Older active Pro rows predate immutable Stripe Price tracking. They were
-- already trusted by the former entitlement model, so retain their current
-- access through a non-checkout legacy offer. The next canonical Stripe read
-- replaces this sentinel with the verified historical offer for that Price.
INSERT INTO "BillingOffer" (
    "id",
    "kind",
    "stripePriceId",
    "stripeProductId",
    "unitAmount",
    "currency",
    "creditAmount",
    "recurringInterval",
    "recurringIntervalCount",
    "checkoutEnabled",
    "updatedAt"
)
VALUES (
    'legacy-pro-pre-offer-versioning-2026-08-11',
    'pro',
    'legacy-pro-price-pre-offer-versioning-2026-08-11',
    'legacy-pro-product-pre-offer-versioning-2026-08-11',
    1,
    'usd',
    NULL,
    'month',
    1,
    false,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

UPDATE "Subscription"
SET "billingOfferId" = 'legacy-pro-pre-offer-versioning-2026-08-11'
WHERE "billingOfferId" IS NULL
  AND "status" = 'active'
  AND "planId" = 'pro'
  AND "currentPeriodEnd" > CURRENT_TIMESTAMP;

-- Unbound attempts have no remote handle and are safe to discard. The preflight
-- above guarantees that no payable bound Session reaches this cleanup.
DELETE FROM "ProCheckoutAttempt"
WHERE "stripeCheckoutSessionId" IS NULL;
ALTER TABLE "ProCheckoutAttempt" ADD COLUMN "billingOfferId" STRING NOT NULL;

CREATE INDEX "Subscription_billingOfferId_idx"
ON "Subscription"("billingOfferId");
CREATE INDEX "CreditTransaction_billingOfferId_idx"
ON "CreditTransaction"("billingOfferId");
CREATE UNIQUE INDEX "CreditTransaction_topUpCheckoutAttemptId_key"
ON "CreditTransaction"("topUpCheckoutAttemptId");
CREATE INDEX "ProCheckoutAttempt_billingOfferId_idx"
ON "ProCheckoutAttempt"("billingOfferId");

ALTER TABLE "Subscription"
ADD CONSTRAINT "Subscription_billingOfferId_fkey"
FOREIGN KEY ("billingOfferId") REFERENCES "BillingOffer"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditTransaction"
ADD CONSTRAINT "CreditTransaction_billingOfferId_fkey"
FOREIGN KEY ("billingOfferId") REFERENCES "BillingOffer"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProCheckoutAttempt"
ADD CONSTRAINT "ProCheckoutAttempt_billingOfferId_fkey"
FOREIGN KEY ("billingOfferId") REFERENCES "BillingOffer"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- A top-up attempt is ownership evidence written before Checkout starts. It
-- deliberately has no User foreign key so a delayed successful payment can be
-- refunded after the account itself has been deleted.
CREATE TABLE "TopUpCheckoutAttempt" (
    "id" STRING NOT NULL DEFAULT gen_random_uuid(),
    "ownerUserId" STRING NOT NULL,
    "stripeCustomerId" STRING NOT NULL,
    "billingOfferId" STRING NOT NULL,
    "stripeCheckoutSessionId" STRING,
    "stripePaymentIntentId" STRING,
    "status" STRING NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "accountDeletionAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "refundId" STRING,
    "refundStatus" STRING,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopUpCheckoutAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TopUpCheckoutAttempt_status_check"
        CHECK ("status" IN (
            'open', 'payment_pending', 'fulfilled', 'refund_required',
            'refund_pending', 'refunded', 'refund_failed'
    ))
);

ALTER TABLE "TopUpCheckoutAttempt" SET (schema_locked = false);

CREATE UNIQUE INDEX "TopUpCheckoutAttempt_stripeCheckoutSessionId_key"
ON "TopUpCheckoutAttempt"("stripeCheckoutSessionId");
CREATE UNIQUE INDEX "TopUpCheckoutAttempt_stripePaymentIntentId_key"
ON "TopUpCheckoutAttempt"("stripePaymentIntentId");
CREATE INDEX "TopUpCheckoutAttempt_ownerUserId_status_idx"
ON "TopUpCheckoutAttempt"("ownerUserId", "status");
CREATE INDEX "TopUpCheckoutAttempt_billingOfferId_idx"
ON "TopUpCheckoutAttempt"("billingOfferId");

ALTER TABLE "TopUpCheckoutAttempt"
ADD CONSTRAINT "TopUpCheckoutAttempt_billingOfferId_fkey"
FOREIGN KEY ("billingOfferId") REFERENCES "BillingOffer"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditTransaction"
ADD CONSTRAINT "CreditTransaction_topUpCheckoutAttemptId_fkey"
FOREIGN KEY ("topUpCheckoutAttemptId") REFERENCES "TopUpCheckoutAttempt"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- Reversal holds are independent rows because overlapping disputes/refunds
-- must keep access suspended until every active reversal is restored. Bind
-- them to the User plus Stripe's immutable subscription ID, not to the single
-- mutable local Subscription row, so replacing a subscription cannot carry an
-- old dispute onto the new entitlement.
CREATE TABLE "SubscriptionEntitlementHold" (
    "id" STRING NOT NULL DEFAULT gen_random_uuid(),
    "userId" STRING NOT NULL,
    "stripeSubscriptionId" STRING NOT NULL,
    "stripePaymentIntentId" STRING NOT NULL,
    "stripeReversalKind" STRING NOT NULL,
    "stripeReversalId" STRING NOT NULL,
    "status" STRING NOT NULL,
    "active" BOOL NOT NULL,
    "progressionRank" INT4 NOT NULL DEFAULT 0,
    "stripeEventId" STRING NOT NULL,
    "stripeEventCreatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionEntitlementHold_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SubscriptionEntitlementHold_kind_check"
        CHECK ("stripeReversalKind" IN ('refund', 'dispute'))
);

ALTER TABLE "SubscriptionEntitlementHold" SET (schema_locked = false);

CREATE UNIQUE INDEX "SubscriptionEntitlementHold_kind_id_key"
ON "SubscriptionEntitlementHold"("stripeReversalKind", "stripeReversalId");
CREATE INDEX "SubscriptionEntitlementHold_user_subscription_active_idx"
ON "SubscriptionEntitlementHold"("userId", "stripeSubscriptionId", "active");
CREATE INDEX "SubscriptionEntitlementHold_paymentIntent_idx"
ON "SubscriptionEntitlementHold"("stripePaymentIntentId");

ALTER TABLE "SubscriptionEntitlementHold"
ADD CONSTRAINT "SubscriptionEntitlementHold_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Account deletion cannot cancel OpenRouter video jobs because the provider
-- currently exposes submit/poll/content operations only. Preserve active
-- remote job IDs outside the User cascade so scheduled reconciliation can poll
-- them to a terminal state and deliberately discard their output.
CREATE TABLE "AiRemoteJobCleanup" (
    "provider" STRING NOT NULL,
    "providerJobId" STRING NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3),
    "attempts" INT4 NOT NULL DEFAULT 0,
    "lastError" STRING,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiRemoteJobCleanup_pkey"
        PRIMARY KEY ("provider", "providerJobId")
);

ALTER TABLE "AiRemoteJobCleanup" SET (schema_locked = false);

CREATE INDEX "AiRemoteJobCleanup_notBefore_leaseExpiresAt_idx"
ON "AiRemoteJobCleanup"("notBefore", "leaseExpiresAt");

ALTER TABLE "BillingOffer" SET (schema_locked = true);
ALTER TABLE "TopUpCheckoutAttempt" SET (schema_locked = true);
ALTER TABLE "SubscriptionEntitlementHold" SET (schema_locked = true);
ALTER TABLE "AiRemoteJobCleanup" SET (schema_locked = true);
ALTER TABLE "Subscription" SET (schema_locked = true);
ALTER TABLE "CreditTransaction" SET (schema_locked = true);
ALTER TABLE "ProCheckoutAttempt" SET (schema_locked = true);
