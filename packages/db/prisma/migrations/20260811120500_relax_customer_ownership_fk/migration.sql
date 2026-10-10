-- Customer ownership is deliberately validated by fail-closed runtime reads
-- instead of a Customer -> StripeCustomerOwnership foreign key. Keeping the
-- relationship non-enforcing lets an older application instance continue to
-- write Customer during a rolling deployment; the new application refuses to
-- trust that mapping until its verified ownership row has been dual-written.
ALTER TABLE "Customer"
DROP CONSTRAINT IF EXISTS "Customer_stripeId_userId_fkey";
