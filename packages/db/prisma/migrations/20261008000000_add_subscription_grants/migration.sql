-- Plan entitlements granted by an administrator without a Stripe subscription.
-- The user foreign key also changes the referenced User table, so both tables
-- are unlocked for the change.
CREATE TABLE "SubscriptionGrant" (
  "id" STRING NOT NULL, "userId" STRING NOT NULL, "planId" STRING NOT NULL, "tier" STRING,
  "startsAt" TIMESTAMP(3) NOT NULL, "endsAt" TIMESTAMP(3),
  "reason" STRING NOT NULL, "grantedByUserId" STRING NOT NULL,
  "revokedAt" TIMESTAMP(3), "revokedByUserId" STRING,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriptionGrant_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "SubscriptionGrant" SET (schema_locked = false);
ALTER TABLE "User" SET (schema_locked = false);
CREATE INDEX "SubscriptionGrant_userId_planId_revokedAt_idx" ON "SubscriptionGrant"("userId", "planId", "revokedAt");
ALTER TABLE "SubscriptionGrant" ADD CONSTRAINT "SubscriptionGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "User" SET (schema_locked = true);
ALTER TABLE "SubscriptionGrant" SET (schema_locked = true);
