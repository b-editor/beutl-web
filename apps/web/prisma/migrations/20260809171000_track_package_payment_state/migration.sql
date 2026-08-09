-- AlterTable
ALTER TABLE "UserPaymentHistory"
ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE "UserPaymentHistory"
ADD COLUMN "revocationReason" STRING;
ALTER TABLE "UserPaymentHistory"
ADD COLUMN "stripeStateEventId" STRING;
ALTER TABLE "UserPaymentHistory"
ADD COLUMN "stripeStateEventCreatedAt" TIMESTAMP(3);
ALTER TABLE "UserPaymentHistory"
ADD COLUMN "stripeStateEventRank" INT4 NOT NULL DEFAULT 0;

ALTER TABLE "UserPackage"
ADD COLUMN "paymentManaged" BOOL NOT NULL DEFAULT false;

-- Existing paid entitlements were created by the Stripe webhook.
UPDATE "UserPackage" AS up
SET "paymentManaged" = true
WHERE EXISTS (
  SELECT 1
  FROM "UserPaymentHistory" AS history
  WHERE history."userId" = up."userId"
    AND history."packageId" = up."packageId"
);

-- Keep one deterministic owner for any legacy Stripe customer that was mapped
-- to multiple users. Removed users receive a new owned customer on checkout.
WITH ranked_customer_owners AS (
  SELECT
    "userId",
    row_number() OVER (
      PARTITION BY "stripeId"
      ORDER BY "createdAt", "userId"
    ) AS owner_rank
  FROM "Customer"
)
DELETE FROM "Customer"
WHERE "userId" IN (
  SELECT "userId"
  FROM ranked_customer_owners
  WHERE owner_rank > 1
);

-- CreateIndex
CREATE INDEX "UserPaymentHistory_userId_packageId_revokedAt_idx"
ON "UserPaymentHistory"("userId", "packageId", "revokedAt");

CREATE UNIQUE INDEX "Customer_stripeId_key"
ON "Customer"("stripeId");
