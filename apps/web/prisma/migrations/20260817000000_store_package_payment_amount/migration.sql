-- Package purchases recorded only the Stripe payment id, so the billing page had
-- to call Stripe once per row to show an amount. The webhook already hands
-- recordPackagePaymentSucceeded the charged amount and currency after matching
-- them against PackagePricing; persist that instead of re-reading Stripe.
--
-- Both columns stay nullable. Rows written before this migration have no amount
-- until the backfill script fills them, and a revocation that arrives before its
-- success event legitimately creates a row with no charge to record.
ALTER TABLE "UserPaymentHistory"
ADD COLUMN "stripePaymentAmount" INT4;
ALTER TABLE "UserPaymentHistory"
ADD COLUMN "stripeCurrency" STRING;
