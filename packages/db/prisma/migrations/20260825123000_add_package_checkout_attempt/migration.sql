CREATE TABLE "PackageCheckoutAttempt" (
  "id" STRING NOT NULL,
  "userId" STRING NOT NULL,
  "packageId" STRING NOT NULL,
  "fingerprint" STRING NOT NULL,
  "checkoutKey" STRING NOT NULL,
  "stripeCheckoutSessionId" STRING,
  "customerId" STRING NOT NULL,
  "paramsJson" STRING NOT NULL,
  "accountDeletionAt" TIMESTAMP(3),
  "recoveryLeaseToken" STRING,
  "recoveryLeaseExpiresAt" TIMESTAMP(3),
  "recoveryAttempts" INT4 NOT NULL DEFAULT 0,
  "recoveryLastError" STRING,
  "recoveryInterventionAt" TIMESTAMP(3),
  "status" STRING NOT NULL DEFAULT 'open',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PackageCheckoutAttempt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PackageCheckoutAttempt" SET (schema_locked = false);
CREATE UNIQUE INDEX "PackageCheckoutAttempt_checkoutKey_key" ON "PackageCheckoutAttempt" ("checkoutKey");
CREATE UNIQUE INDEX "PackageCheckoutAttempt_stripeCheckoutSessionId_key" ON "PackageCheckoutAttempt" ("stripeCheckoutSessionId");
CREATE UNIQUE INDEX "PackageCheckoutAttempt_userId_packageId_key" ON "PackageCheckoutAttempt" ("userId", "packageId");
CREATE INDEX "PackageCheckoutAttempt_userId_packageId_status_idx" ON "PackageCheckoutAttempt" ("userId", "packageId", "status");
CREATE INDEX "PackageCheckoutAttempt_recovery_idx" ON "PackageCheckoutAttempt" ("status", "accountDeletionAt", "recoveryLeaseExpiresAt");
ALTER TABLE "PackageCheckoutAttempt" ADD CONSTRAINT "PackageCheckoutAttempt_status_check" CHECK ("status" IN ('open', 'recovering', 'terminal', 'intervention'));
ALTER TABLE "PackageCheckoutAttempt" ADD CONSTRAINT "PackageCheckoutAttempt_recovery_lease_pair_check" CHECK (("recoveryLeaseToken" IS NULL AND "recoveryLeaseExpiresAt" IS NULL) OR ("recoveryLeaseToken" IS NOT NULL AND "recoveryLeaseExpiresAt" IS NOT NULL));
ALTER TABLE "PackageCheckoutAttempt" SET (schema_locked = true);
