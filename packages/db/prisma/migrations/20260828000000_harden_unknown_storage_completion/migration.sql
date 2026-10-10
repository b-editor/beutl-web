-- Preserve provider calls whose remote outcome is unknown. This is a
-- forward-only repair after 20260827030000; never edit that applied migration.
ALTER TABLE "StorageUpload" SET (schema_locked = false);
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_completionLease_pair_ck";
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_completionState_ck";
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_completionIntervention_ck";

ALTER TABLE "StorageUpload"
  ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionLease_pair_ck"
  CHECK (
    ("completionState" = 'idle' AND "completionLeaseToken" IS NULL AND "completionLeaseUntil" IS NULL)
    OR ("completionState" = 'completing' AND "completionLeaseToken" IS NOT NULL AND "completionLeaseUntil" IS NOT NULL)
    OR ("completionState" IN ('retry', 'resumed', 'settled', 'intervention', 'unknown') AND "completionLeaseToken" IS NULL AND "completionLeaseUntil" IS NULL)
  );

ALTER TABLE "StorageUpload"
  ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionState_ck"
  CHECK ("completionState" IN ('idle', 'retry', 'resumed', 'completing', 'settled', 'intervention', 'unknown'));
ALTER TABLE "StorageUpload"
  ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionIntervention_ck"
  CHECK (("completionState" IN ('intervention', 'unknown') AND "completionInterventionAt" IS NOT NULL) OR ("completionState" NOT IN ('intervention', 'unknown') AND "completionInterventionAt" IS NULL));

ALTER TABLE "StorageUpload" SET (schema_locked = true);
