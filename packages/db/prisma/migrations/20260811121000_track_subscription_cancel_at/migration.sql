-- A custom Stripe cancellation date can precede the normal billing-period end.
-- Persist it so entitlement checks fail closed even if the terminal webhook is
-- delayed, and so account surfaces show the actual access end.
ALTER TABLE "Subscription" SET (schema_locked = false);

ALTER TABLE "Subscription"
ADD COLUMN "cancelAt" TIMESTAMP(3);

ALTER TABLE "Subscription" SET (schema_locked = true);
