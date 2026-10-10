-- A cancellation made in the Stripe customer portal does not delete the
-- subscription. Stripe keeps it active until the period ends and only flags
-- cancel_at_period_end, so without this column the account screens cannot tell
-- the user that their plan is scheduled to end.
ALTER TABLE "Subscription" SET (schema_locked = false);

ALTER TABLE "Subscription"
ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Subscription" SET (schema_locked = true);
