-- Older Gateway videos did not record whether a null audit value meant an
-- estimate or an actual charge too large for the legacy INT4 audit column.
-- Backfill only rows whose settled units are mathematically below the
-- smallest possible charge for an overflowing provider cost ($2147.483648).
-- This never reclassifies an already actual-billed overflow as an estimate.
INSERT INTO "CreditTransaction" (
  "id", "userId", "creditAmount", "debtAmount", "usageAmount",
  "usagePeriodStart", "usagePeriodEnd", "kind", "aiJobId"
)
SELECT
  gen_random_uuid()::STRING, job."userId", 0, 0, 0,
  reservation."usagePeriodStart", reservation."usagePeriodEnd",
  'usage_estimate_pending', job."id"
FROM "AiJob" AS job
JOIN "CreditTransaction" AS reservation
  ON reservation."aiJobId" = job."id" AND reservation."kind" = 'usage'
WHERE job."provider" = 'vercel-gateway'
  AND job."kind" = 'video'
  AND job."status" = 'succeeded'
  AND job."usageSettledAt" IS NOT NULL
  AND job."providerCostUsdMicros" IS NULL
  AND job."providerJobId" IS NOT NULL
  AND job."model" IS NOT NULL
  AND job."usageUnitUsdMicros" > 0
  AND job."usagePercent" > 0
  AND job."reservedUsageUnits" IS NOT NULL
  AND job."usageUnits" * job."usageUnitUsdMicros" * 100
      < 2147483648::DECIMAL * job."usagePercent"
  AND NOT EXISTS (
    SELECT 1 FROM "CreditTransaction" AS correction
    WHERE correction."aiJobId" = job."id"
      AND correction."kind" = 'usage_actual_correction'
  )
ON CONFLICT ("aiJobId", "kind") DO NOTHING;
