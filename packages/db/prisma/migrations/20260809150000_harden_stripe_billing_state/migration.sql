-- Customer.stripeId uniqueness is owned by the later
-- 20260809171000_track_package_payment_state migration. Keeping a single
-- creator makes this migration chain valid both on fresh databases and on
-- databases where the main-branch security migration ran first.

-- Subscription webhooks carry a durable event watermark plus a deterministic
-- observation rank. Application-level compare-and-set updates use all three to
-- prevent a stalled handler from overwriting a newer status or billing period.
ALTER TABLE "Subscription" ADD COLUMN "stripeEventId" STRING;
ALTER TABLE "Subscription" ADD COLUMN "stripeEventCreatedAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "stripeObservationRank" STRING;

-- Refund/dispute progression is monotonic. Backfill any development rows from
-- their canonical status so a pending observation cannot reactivate a terminal
-- state; production is not expected to contain rows from this undeployed feature.
ALTER TABLE "StripeCreditReversal"
ADD COLUMN "progressionRank" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "StripeCreditReversal" ADD COLUMN "stripeEventId" STRING;
ALTER TABLE "StripeCreditReversal"
ADD COLUMN "stripeEventCreatedAt" TIMESTAMP(3);

UPDATE "StripeCreditReversal"
SET "progressionRank" = CASE
    WHEN "stripeReversalKind" = 'refund'
         AND "status" IN ('succeeded', 'failed', 'canceled') THEN 100
    WHEN "stripeReversalKind" = 'dispute'
         AND "status" IN ('lost', 'won', 'prevented', 'warning_closed') THEN 100
    ELSE 10
END;
