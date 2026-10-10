-- Snapshot only customer mappings that predate ownership metadata into an
-- explicit migration cohort. Runtime code may use this exact user/customer
-- pair for legacy verification, while every later mapping must insert a
-- verified ownership row before it can be referenced by Customer.
CREATE TABLE "StripeCustomerOwnership" (
    "stripeId" STRING NOT NULL,
    "userId" STRING NOT NULL,
    "migrationCohort" STRING,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeCustomerOwnership_pkey" PRIMARY KEY ("stripeId"),
    CONSTRAINT "StripeCustomerOwnership_has_proof_check"
    CHECK ("migrationCohort" IS NOT NULL OR "verifiedAt" IS NOT NULL)
);

ALTER TABLE "StripeCustomerOwnership" SET (schema_locked = false);

INSERT INTO "StripeCustomerOwnership" (
    "stripeId",
    "userId",
    "migrationCohort",
    "verifiedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    "stripeId",
    "userId",
    'pre-owner-metadata-2026-08-09',
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Customer";

CREATE UNIQUE INDEX "StripeCustomerOwnership_stripeId_userId_key"
ON "StripeCustomerOwnership"("stripeId", "userId");

CREATE INDEX "StripeCustomerOwnership_userId_idx"
ON "StripeCustomerOwnership"("userId");

ALTER TABLE "StripeCustomerOwnership"
ADD CONSTRAINT "StripeCustomerOwnership_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Customer_stripeId_userId_key"
ON "Customer"("stripeId", "userId");

ALTER TABLE "Customer"
ADD CONSTRAINT "Customer_stripeId_userId_fkey"
FOREIGN KEY ("stripeId", "userId")
REFERENCES "StripeCustomerOwnership"("stripeId", "userId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Consuming an account-deletion token creates this resumable authorization in
-- the same transaction. Stripe closure therefore always happens after durable
-- authorization, and the original link can resume without an unexpired token.
CREATE TABLE "AccountDeletionIntent" (
    "identifier" STRING NOT NULL,
    "tokenHash" STRING NOT NULL,
    "userId" STRING NOT NULL,
    "stripeCustomerId" STRING,
    "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountDeletionIntent_pkey"
    PRIMARY KEY ("identifier", "tokenHash")
);

ALTER TABLE "AccountDeletionIntent" SET (schema_locked = false);

CREATE INDEX "AccountDeletionIntent_userId_idx"
ON "AccountDeletionIntent"("userId");

ALTER TABLE "AccountDeletionIntent"
ADD CONSTRAINT "AccountDeletionIntent_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Stripe event timestamps have one-second precision. This local timestamp
-- orders canonical Stripe retrievals for reversible states within that second;
-- terminal states remain monotonic independently of this value.
ALTER TABLE "Subscription"
ADD COLUMN "stripeCanonicalObservedAt" TIMESTAMP(3);
