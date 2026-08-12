-- AI credit purchases were not deployed before this ledger replacement. Do
-- not silently reinterpret an unexpected legacy purchase without its Stripe
-- amount/currency provenance. Adding this ordinary CHECK validates every
-- existing row on PostgreSQL and CockroachDB; dropping it immediately keeps
-- the migrated schema open for the new, fully-attributed purchase records.
-- If this fails, reconcile or remove those rows deliberately before retrying.
ALTER TABLE "CreditTransaction"
ADD CONSTRAINT "CreditTransaction_no_unreconciled_legacy_purchase"
CHECK ("kind" <> 'purchase');

ALTER TABLE "CreditTransaction"
DROP CONSTRAINT "CreditTransaction_no_unreconciled_legacy_purchase";

-- Stop legacy in-flight work before changing the ledger model. The previous
-- ledger did not record whether a charge came from included or purchased
-- credits, so outstanding charges are conservatively returned as persistent
-- credits. This avoids losing user-funded value during the one-time cutover.
WITH "OutstandingAiCharges" AS (
    SELECT
        "AiJob"."id" AS "aiJobId",
        "AiJob"."userId" AS "userId",
        GREATEST(-SUM("CreditTransaction"."amount"), 0)::INT AS "amount"
    FROM "AiJob"
    INNER JOIN "CreditTransaction"
        ON "CreditTransaction"."aiJobId" = "AiJob"."id"
       AND "CreditTransaction"."kind" IN ('usage', 'refund')
    WHERE "AiJob"."status" IN ('queued', 'running')
    GROUP BY "AiJob"."id", "AiJob"."userId"
),
"RefundsByUser" AS (
    SELECT "userId", SUM("amount")::INT AS "amount"
    FROM "OutstandingAiCharges"
    WHERE "amount" > 0
    GROUP BY "userId"
)
UPDATE "CreditAccount"
SET "purchasedCredits" = "CreditAccount"."purchasedCredits" + "RefundsByUser"."amount"
FROM "RefundsByUser"
WHERE "CreditAccount"."userId" = "RefundsByUser"."userId";

WITH "OutstandingAiCharges" AS (
    SELECT
        "AiJob"."id" AS "aiJobId",
        "AiJob"."userId" AS "userId",
        GREATEST(-SUM("CreditTransaction"."amount"), 0)::INT AS "amount"
    FROM "AiJob"
    INNER JOIN "CreditTransaction"
        ON "CreditTransaction"."aiJobId" = "AiJob"."id"
       AND "CreditTransaction"."kind" IN ('usage', 'refund')
    WHERE "AiJob"."status" IN ('queued', 'running')
    GROUP BY "AiJob"."id", "AiJob"."userId"
)
INSERT INTO "CreditTransaction" (
    "id", "userId", "amount", "kind", "aiJobId", "createdAt"
)
SELECT
    gen_random_uuid()::STRING,
    "userId",
    "amount",
    'refund',
    "aiJobId",
    CURRENT_TIMESTAMP
FROM "OutstandingAiCharges"
WHERE "amount" > 0;

UPDATE "AiJob"
SET
    "status" = 'failed',
    "error" = 'Canceled during monthly usage migration',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN ('queued', 'running');

-- Replace rollover-prone subscription credits with usage tied to one billing
-- period. Preserve the current remainder by converting it into usage already
-- consumed from the new 500-unit monthly allowance.
ALTER TABLE "CreditAccount" ADD COLUMN "monthlyUsageUsed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CreditAccount" ADD COLUMN "usagePeriodStart" TIMESTAMP(3);
ALTER TABLE "CreditAccount" ADD COLUMN "usagePeriodEnd" TIMESTAMP(3);

UPDATE "CreditAccount"
SET
    "monthlyUsageUsed" = 500 - LEAST(GREATEST("subscriptionCredits", 0), 500),
    "usagePeriodEnd" = "Subscription"."currentPeriodEnd"
FROM "Subscription"
WHERE "CreditAccount"."userId" = "Subscription"."userId";

ALTER TABLE "CreditAccount" DROP COLUMN "subscriptionCredits";

-- Credit deltas and included-usage deltas are tracked independently.
ALTER TABLE "CreditTransaction" RENAME COLUMN "amount" TO "creditAmount";
ALTER TABLE "CreditTransaction" ADD COLUMN "usageAmount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CreditTransaction" ADD COLUMN "usagePeriodStart" TIMESTAMP(3);
ALTER TABLE "CreditTransaction" ADD COLUMN "usagePeriodEnd" TIMESTAMP(3);

-- Legacy monthly grants do not become persistent top-up credits.
DELETE FROM "CreditTransaction" WHERE "kind" = 'subscription_grant';

-- Older retry paths could write duplicate usage/refund rows. Consolidate their
-- deltas before enforcing future idempotency so the normalized ledger still
-- reconciles with CreditAccount.
WITH "TransactionGroups" AS (
    SELECT
        "aiJobId",
        "kind",
        MIN("id") AS "keptId",
        SUM("creditAmount")::INT AS "totalCreditAmount"
    FROM "CreditTransaction"
    WHERE "aiJobId" IS NOT NULL
    GROUP BY "aiJobId", "kind"
    HAVING COUNT(*) > 1
)
UPDATE "CreditTransaction"
SET "creditAmount" = "TransactionGroups"."totalCreditAmount"
FROM "TransactionGroups"
WHERE "CreditTransaction"."id" = "TransactionGroups"."keptId";

DELETE FROM "CreditTransaction"
WHERE "id" IN (
    SELECT "CreditTransaction"."id"
    FROM "CreditTransaction"
    INNER JOIN (
        SELECT "aiJobId", "kind", MIN("id") AS "keptId"
        FROM "CreditTransaction"
        WHERE "aiJobId" IS NOT NULL
        GROUP BY "aiJobId", "kind"
        HAVING COUNT(*) > 1
    ) AS "TransactionGroups"
        ON "CreditTransaction"."aiJobId" = "TransactionGroups"."aiJobId"
       AND "CreditTransaction"."kind" = "TransactionGroups"."kind"
    WHERE "CreditTransaction"."id" <> "TransactionGroups"."keptId"
);

CREATE UNIQUE INDEX "CreditTransaction_aiJobId_kind_key"
ON "CreditTransaction"("aiJobId", "kind");

ALTER TABLE "AiJob" RENAME COLUMN "creditsCost" TO "usageUnits";
ALTER TABLE "Subscription" ADD COLUMN "currentPeriodStart" TIMESTAMP(3);

CREATE TABLE "ProCheckoutAttempt" (
    "userId" STRING NOT NULL,
    "checkoutKey" STRING NOT NULL,
    "stripeCheckoutSessionId" STRING,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProCheckoutAttempt_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "ProCheckoutAttempt" SET (schema_locked = false);

CREATE UNIQUE INDEX "ProCheckoutAttempt_checkoutKey_key"
ON "ProCheckoutAttempt"("checkoutKey");

ALTER TABLE "ProCheckoutAttempt"
ADD CONSTRAINT "ProCheckoutAttempt_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Stripe reversals never make either balance negative. If a refund or dispute
-- exceeds the currently unspent purchased balance, the difference becomes
-- debt that future credit value must settle before it becomes spendable.
ALTER TABLE "CreditAccount"
ADD COLUMN "purchasedCreditDebt" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "CreditAccount"
ADD CONSTRAINT "CreditAccount_purchasedCredits_nonnegative"
CHECK ("purchasedCredits" >= 0);

ALTER TABLE "CreditAccount"
ADD CONSTRAINT "CreditAccount_purchasedCreditDebt_nonnegative"
CHECK ("purchasedCreditDebt" >= 0);

-- Keep the gross credit entitlement and debt movement separate. Their sum is
-- the actual purchased-credit balance delta. Stripe money fields allow several
-- partial reversals to be converted cumulatively without rounding each event.
ALTER TABLE "CreditTransaction" ADD COLUMN "debtAmount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CreditTransaction" ADD COLUMN "stripePaymentAmount" INTEGER;
ALTER TABLE "CreditTransaction" ADD COLUMN "stripeCurrency" STRING;
ALTER TABLE "CreditTransaction" ADD COLUMN "stripeSourcePaymentId" STRING;
ALTER TABLE "CreditTransaction" ADD COLUMN "stripeReversalKind" STRING;
ALTER TABLE "CreditTransaction" ADD COLUMN "stripeReversalId" STRING;
ALTER TABLE "CreditTransaction" ADD COLUMN "stripeReversalRevision" INTEGER;

UPDATE "CreditTransaction"
SET "stripeSourcePaymentId" = "stripePaymentId"
WHERE "kind" = 'purchase' AND "stripePaymentId" IS NOT NULL;

CREATE INDEX "CreditTransaction_stripeSourcePaymentId_idx"
ON "CreditTransaction"("stripeSourcePaymentId");

CREATE UNIQUE INDEX "CreditTransaction_stripeReversalKind_stripeReversalId_stripeReversalRevision_key"
ON "CreditTransaction"("stripeReversalKind", "stripeReversalId", "stripeReversalRevision");

-- Store the latest canonical state of each Stripe refund/dispute independently
-- from its ledger adjustments. This lets out-of-order webhook deliveries be
-- reconciled and lets a reversal received before its PaymentIntent grant apply
-- as soon as that grant is recorded.
CREATE TABLE "StripeCreditReversal" (
    "id" STRING NOT NULL,
    "stripePaymentId" STRING NOT NULL,
    "stripeReversalKind" STRING NOT NULL,
    "stripeReversalId" STRING NOT NULL,
    "stripeAmount" INTEGER NOT NULL,
    "stripeCurrency" STRING NOT NULL,
    "status" STRING NOT NULL,
    "active" BOOL NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeCreditReversal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StripeCreditReversal_amount_positive" CHECK ("stripeAmount" > 0),
    CONSTRAINT "StripeCreditReversal_revision_positive" CHECK ("revision" > 0)
);

ALTER TABLE "StripeCreditReversal" SET (schema_locked = false);

CREATE UNIQUE INDEX "StripeCreditReversal_stripeReversalKind_stripeReversalId_key"
ON "StripeCreditReversal"("stripeReversalKind", "stripeReversalId");

CREATE INDEX "StripeCreditReversal_stripePaymentId_idx"
ON "StripeCreditReversal"("stripePaymentId");

-- AI job history is user-visible and soft-deleted so usage transactions retain
-- their job reference. The composite index supports stable newest-first scans.
ALTER TABLE "AiJob" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "AiJob_userId_deletedAt_createdAt_id_idx"
ON "AiJob"("userId", "deletedAt", "createdAt", "id");
