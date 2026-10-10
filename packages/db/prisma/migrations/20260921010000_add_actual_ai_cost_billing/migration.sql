ALTER TABLE "AiOperationModel"
ADD COLUMN "usagePercent" INT4 NOT NULL DEFAULT 100;

ALTER TABLE "AiOperationModel"
ADD CONSTRAINT "AiOperationModel_usagePercent_check"
CHECK ("usagePercent" >= 1 AND "usagePercent" <= 10000);

ALTER TABLE "AiJob"
ADD COLUMN "reservedUsageUnits" INT4,
ADD COLUMN "estimatedUsageUnits" INT4,
ADD COLUMN "usageUnitUsdMicros" INT4,
ADD COLUMN "usagePercent" INT4 NOT NULL DEFAULT 100,
ADD COLUMN "providerCostUsdMicros" INT4,
ADD COLUMN "usageSettledAt" TIMESTAMPTZ;

ALTER TABLE "AiJob"
ADD CONSTRAINT "AiJob_reservedUsageUnits_check"
CHECK ("reservedUsageUnits" IS NULL OR "reservedUsageUnits" >= 0),
ADD CONSTRAINT "AiJob_estimatedUsageUnits_check"
CHECK ("estimatedUsageUnits" IS NULL OR "estimatedUsageUnits" >= 0),
ADD CONSTRAINT "AiJob_usageUnitUsdMicros_check"
CHECK ("usageUnitUsdMicros" IS NULL OR "usageUnitUsdMicros" > 0),
ADD CONSTRAINT "AiJob_usagePercent_check"
CHECK ("usagePercent" >= 1 AND "usagePercent" <= 10000),
ADD CONSTRAINT "AiJob_providerCostUsdMicros_check"
CHECK ("providerCostUsdMicros" IS NULL OR "providerCostUsdMicros" >= 0);
