CREATE TABLE "StripeCheckoutCleanup" (
  "id" STRING NOT NULL,
  "sessionId" STRING NOT NULL,
  "userId" STRING NOT NULL,
  "kind" STRING NOT NULL,
  "customerId" STRING NOT NULL,
  "packageId" STRING,
  "billingOfferId" STRING,
  "status" STRING NOT NULL DEFAULT 'required',
  "notBefore" TIMESTAMP(3) NOT NULL,
  "attempts" INT4 NOT NULL DEFAULT 0,
  "leaseToken" STRING,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastError" STRING,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StripeCheckoutCleanup_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "StripeCheckoutCleanup" SET (schema_locked = false);
CREATE UNIQUE INDEX "StripeCheckoutCleanup_sessionId_key" ON "StripeCheckoutCleanup" ("sessionId");
CREATE INDEX "StripeCheckoutCleanup_userId_status_idx" ON "StripeCheckoutCleanup" ("userId", "status");
CREATE INDEX "StripeCheckoutCleanup_status_notBefore_leaseExpiresAt_idx" ON "StripeCheckoutCleanup" ("status", "notBefore", "leaseExpiresAt");
ALTER TABLE "StripeCheckoutCleanup" ADD CONSTRAINT "StripeCheckoutCleanup_status_check" CHECK ("status" IN ('required', 'retry', 'completed', 'intervention'));
ALTER TABLE "StripeCheckoutCleanup" ADD CONSTRAINT "StripeCheckoutCleanup_kind_check" CHECK ("kind" IN ('package', 'pro'));
ALTER TABLE "StripeCheckoutCleanup" ADD CONSTRAINT "StripeCheckoutCleanup_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "StripeCheckoutCleanup" ADD CONSTRAINT "StripeCheckoutCleanup_lease_pair_check" CHECK (("leaseToken" IS NULL AND "leaseExpiresAt" IS NULL) OR ("leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL));
ALTER TABLE "StripeCheckoutCleanup" SET (schema_locked = true);
