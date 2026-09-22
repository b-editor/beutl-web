-- Usage charges are derived from provider prices and can be smaller than one
-- unit. Six fractional places match the micro-USD precision used to retain the
-- provider charge, while DECIMAL keeps balances and ledger deltas exact.
--
-- This uses add/backfill/swap instead of ALTER COLUMN TYPE. Cockroach clusters
-- that use the legacy schema changer reject general ALTER COLUMN TYPE, whereas
-- these ordinary column changes work with either schema changer.
ALTER TABLE "CreditAccount" SET (schema_locked = false);
ALTER TABLE "CreditTransaction" SET (schema_locked = false);
ALTER TABLE "AiJob" SET (schema_locked = false);

ALTER TABLE "CreditAccount"
ADD COLUMN "monthlyUsageUsedDecimal" DECIMAL(16, 6) NOT NULL DEFAULT 0,
ADD COLUMN "purchasedCreditsDecimal" DECIMAL(16, 6) NOT NULL DEFAULT 0,
ADD COLUMN "purchasedCreditDebtDecimal" DECIMAL(16, 6) NOT NULL DEFAULT 0;

UPDATE "CreditAccount"
SET
  "monthlyUsageUsedDecimal" = "monthlyUsageUsed",
  "purchasedCreditsDecimal" = "purchasedCredits",
  "purchasedCreditDebtDecimal" = "purchasedCreditDebt";

ALTER TABLE "CreditAccount"
DROP CONSTRAINT "CreditAccount_purchasedCredits_nonnegative",
DROP CONSTRAINT "CreditAccount_purchasedCreditDebt_nonnegative";
ALTER TABLE "CreditAccount"
DROP COLUMN "monthlyUsageUsed",
DROP COLUMN "purchasedCredits",
DROP COLUMN "purchasedCreditDebt";
ALTER TABLE "CreditAccount"
RENAME COLUMN "monthlyUsageUsedDecimal" TO "monthlyUsageUsed";
ALTER TABLE "CreditAccount"
RENAME COLUMN "purchasedCreditsDecimal" TO "purchasedCredits";
ALTER TABLE "CreditAccount"
RENAME COLUMN "purchasedCreditDebtDecimal" TO "purchasedCreditDebt";
ALTER TABLE "CreditAccount"
ADD CONSTRAINT "CreditAccount_purchasedCredits_nonnegative"
CHECK ("purchasedCredits" >= 0),
ADD CONSTRAINT "CreditAccount_purchasedCreditDebt_nonnegative"
CHECK ("purchasedCreditDebt" >= 0);

ALTER TABLE "CreditTransaction"
ADD COLUMN "creditAmountDecimal" DECIMAL(16, 6),
ADD COLUMN "debtAmountDecimal" DECIMAL(16, 6) NOT NULL DEFAULT 0,
ADD COLUMN "usageAmountDecimal" DECIMAL(16, 6) NOT NULL DEFAULT 0;

UPDATE "CreditTransaction"
SET
  "creditAmountDecimal" = "creditAmount",
  "debtAmountDecimal" = "debtAmount",
  "usageAmountDecimal" = "usageAmount";

ALTER TABLE "CreditTransaction"
ALTER COLUMN "creditAmountDecimal" SET NOT NULL;
ALTER TABLE "CreditTransaction"
DROP COLUMN "creditAmount",
DROP COLUMN "debtAmount",
DROP COLUMN "usageAmount";
ALTER TABLE "CreditTransaction"
RENAME COLUMN "creditAmountDecimal" TO "creditAmount";
ALTER TABLE "CreditTransaction"
RENAME COLUMN "debtAmountDecimal" TO "debtAmount";
ALTER TABLE "CreditTransaction"
RENAME COLUMN "usageAmountDecimal" TO "usageAmount";

ALTER TABLE "AiJob"
ADD COLUMN "usageUnitsDecimal" DECIMAL(16, 6),
ADD COLUMN "reservedUsageUnitsDecimal" DECIMAL(16, 6),
ADD COLUMN "estimatedUsageUnitsDecimal" DECIMAL(16, 6);

UPDATE "AiJob"
SET
  "usageUnitsDecimal" = "usageUnits",
  "reservedUsageUnitsDecimal" = "reservedUsageUnits",
  "estimatedUsageUnitsDecimal" = "estimatedUsageUnits";

ALTER TABLE "AiJob"
ALTER COLUMN "usageUnitsDecimal" SET NOT NULL;
ALTER TABLE "AiJob"
DROP CONSTRAINT "AiJob_reservedUsageUnits_check",
DROP CONSTRAINT "AiJob_estimatedUsageUnits_check";
ALTER TABLE "AiJob"
DROP COLUMN "usageUnits",
DROP COLUMN "reservedUsageUnits",
DROP COLUMN "estimatedUsageUnits";
ALTER TABLE "AiJob"
RENAME COLUMN "usageUnitsDecimal" TO "usageUnits";
ALTER TABLE "AiJob"
RENAME COLUMN "reservedUsageUnitsDecimal" TO "reservedUsageUnits";
ALTER TABLE "AiJob"
RENAME COLUMN "estimatedUsageUnitsDecimal" TO "estimatedUsageUnits";
ALTER TABLE "AiJob"
ADD CONSTRAINT "AiJob_reservedUsageUnits_check"
CHECK ("reservedUsageUnits" IS NULL OR "reservedUsageUnits" >= 0),
ADD CONSTRAINT "AiJob_estimatedUsageUnits_check"
CHECK ("estimatedUsageUnits" IS NULL OR "estimatedUsageUnits" >= 0);

ALTER TABLE "CreditAccount" SET (schema_locked = true);
ALTER TABLE "CreditTransaction" SET (schema_locked = true);
ALTER TABLE "AiJob" SET (schema_locked = true);
