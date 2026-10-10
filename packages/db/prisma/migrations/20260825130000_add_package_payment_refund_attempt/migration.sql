CREATE TABLE "PackagePaymentRefundAttempt" (
  "id" STRING NOT NULL,
  "paymentIntentId" STRING NOT NULL,
  "customerId" STRING,
  "userId" STRING,
  "packageId" STRING,
  "amount" INT4 NOT NULL,
  "currency" STRING NOT NULL,
  "reason" STRING NOT NULL,
  "status" STRING NOT NULL DEFAULT 'required',
  "notBefore" TIMESTAMP(3) NOT NULL,
  "attempts" INT4 NOT NULL DEFAULT 0,
  "leaseToken" STRING,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastError" STRING,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PackagePaymentRefundAttempt_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "PackagePaymentRefundAttempt" SET (schema_locked = false);
CREATE UNIQUE INDEX "PackagePaymentRefundAttempt_paymentIntentId_key" ON "PackagePaymentRefundAttempt" ("paymentIntentId");
CREATE INDEX "PackagePaymentRefundAttempt_status_notBefore_leaseExpiresAt_idx" ON "PackagePaymentRefundAttempt" ("status", "notBefore", "leaseExpiresAt");
ALTER TABLE "PackagePaymentRefundAttempt" ADD CONSTRAINT "PackagePaymentRefundAttempt_status_check" CHECK ("status" IN ('required', 'retry', 'refunded', 'intervention'));
ALTER TABLE "PackagePaymentRefundAttempt" ADD CONSTRAINT "PackagePaymentRefundAttempt_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "PackagePaymentRefundAttempt" ADD CONSTRAINT "PackagePaymentRefundAttempt_lease_pair_check" CHECK (("leaseToken" IS NULL AND "leaseExpiresAt" IS NULL) OR ("leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL));
ALTER TABLE "PackagePaymentRefundAttempt" SET (schema_locked = true);
