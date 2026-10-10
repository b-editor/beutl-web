-- StripeCheckoutCleanup.kind names the plan of a subscription Checkout
-- ('pro', 'storage') or 'package'. The original CHECK predates the storage
-- plan; without this a storage Checkout bound during account deletion cannot
-- be queued for cleanup and the deletion transaction fails.
-- Every plan id added to SUBSCRIPTION_PLANS must be added here as well.
-- 前進のみ・再実行可能に書く。
ALTER TABLE "StripeCheckoutCleanup" SET (schema_locked = false);
ALTER TABLE "StripeCheckoutCleanup" DROP CONSTRAINT IF EXISTS "StripeCheckoutCleanup_kind_check";
ALTER TABLE "StripeCheckoutCleanup" ADD CONSTRAINT IF NOT EXISTS "StripeCheckoutCleanup_kind_check"
    CHECK ("kind" IN ('package', 'pro', 'storage'));
ALTER TABLE "StripeCheckoutCleanup" SET (schema_locked = true);
