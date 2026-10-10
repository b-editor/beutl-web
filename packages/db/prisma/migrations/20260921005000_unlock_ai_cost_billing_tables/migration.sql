-- Run before 20260921010000, whose checksum is already recorded in development.
-- Existing deployments leave both tables schema-locked. The companion
-- 20260921030000 migration restores the locks after the billing cutover.
ALTER TABLE "AiOperationModel" SET (schema_locked = false);
ALTER TABLE "AiJob" SET (schema_locked = false);
