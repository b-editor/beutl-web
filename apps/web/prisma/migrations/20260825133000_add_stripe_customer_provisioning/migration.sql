CREATE TABLE "StripeCustomerProvisioning" (
  "id" STRING NOT NULL,
  "userId" STRING NOT NULL,
  "operationKey" STRING NOT NULL,
  "stripeIdempotencyKey" STRING NOT NULL,
  "stripeCustomerId" STRING,
  "paramsJson" STRING NOT NULL,
  "status" STRING NOT NULL DEFAULT 'pending',
  "notBefore" TIMESTAMP(3) NOT NULL,
  "attempts" INT4 NOT NULL DEFAULT 0,
  "leaseToken" STRING,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastError" STRING,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StripeCustomerProvisioning_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "StripeCustomerProvisioning" SET (schema_locked = false);
CREATE UNIQUE INDEX "StripeCustomerProvisioning_operationKey_key" ON "StripeCustomerProvisioning" ("operationKey");
CREATE INDEX "StripeCustomerProvisioning_userId_status_idx" ON "StripeCustomerProvisioning" ("userId", "status");
CREATE INDEX "StripeCustomerProvisioning_status_notBefore_leaseExpiresAt_idx" ON "StripeCustomerProvisioning" ("status", "notBefore", "leaseExpiresAt");
ALTER TABLE "StripeCustomerProvisioning" ADD CONSTRAINT "StripeCustomerProvisioning_status_check" CHECK ("status" IN ('pending', 'mapping', 'cleanup_required', 'settled', 'cleaned', 'intervention'));
ALTER TABLE "StripeCustomerProvisioning" ADD CONSTRAINT "StripeCustomerProvisioning_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "StripeCustomerProvisioning" ADD CONSTRAINT "StripeCustomerProvisioning_lease_pair_check" CHECK (("leaseToken" IS NULL AND "leaseExpiresAt" IS NULL) OR ("leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL));
ALTER TABLE "StripeCustomerProvisioning" SET (schema_locked = true);
