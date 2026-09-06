-- Fence every remote multipart completion with durable, generation-bound state.
-- CockroachDB-compatible forward repair: all additions are replay-safe.
ALTER TABLE "StorageUpload" SET (schema_locked = false);
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "completionState" STRING NOT NULL DEFAULT 'idle';
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "completionLeaseUntil" TIMESTAMP(3);
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "completionLeaseToken" STRING;
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "completionAttempts" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "completionLastError" STRING;
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "completionInterventionAt" TIMESTAMP(3);
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "completionRetryNotBefore" TIMESTAMP(3);
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "completionRevision" INT4 NOT NULL DEFAULT 0;

-- Drop same-name constraints before re-adding them so a partially-applied or
-- incorrect prior definition is repaired deterministically.
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_completionLease_pair_ck";
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_completionState_ck";
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_completionAttempts_ck";
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_completionRevision_ck";
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_completionIntervention_ck";
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_completionRetryNotBefore_ck";

UPDATE "StorageUpload"
SET "completionState" = 'idle'
WHERE "completionState" IS NULL;
UPDATE "StorageUpload"
SET "completionState" = 'retry', "completionLeaseToken" = NULL, "completionLeaseUntil" = NULL
WHERE "completionState" = 'completing'
  AND ("completionLeaseToken" IS NULL OR "completionLeaseUntil" IS NULL);
UPDATE "StorageUpload"
SET "completionInterventionAt" = NULL
WHERE "completionState" <> 'intervention';
UPDATE "StorageUpload"
SET "completionRetryNotBefore" = current_timestamp() + INTERVAL '15 minutes'
WHERE "completionState" IN ('retry', 'resumed') AND "completionRetryNotBefore" IS NULL;
UPDATE "StorageUpload"
SET "completionRetryNotBefore" = NULL
WHERE "completionState" NOT IN ('retry', 'resumed');

ALTER TABLE "StorageUpload"
  ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionLease_pair_ck"
  CHECK (
    ("completionState" = 'idle' AND "completionLeaseToken" IS NULL AND "completionLeaseUntil" IS NULL)
    OR ("completionState" = 'completing' AND "completionLeaseToken" IS NOT NULL AND "completionLeaseUntil" IS NOT NULL)
    OR ("completionState" IN ('retry', 'resumed', 'settled', 'intervention') AND "completionLeaseToken" IS NULL AND "completionLeaseUntil" IS NULL)
  );

ALTER TABLE "StorageUpload"
  ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionState_ck"
  CHECK ("completionState" IN ('idle', 'retry', 'resumed', 'completing', 'settled', 'intervention'));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionAttempts_ck" CHECK ("completionAttempts" >= 0);
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionRevision_ck" CHECK ("completionRevision" >= 0);
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionIntervention_ck" CHECK (("completionState" = 'intervention' AND "completionInterventionAt" IS NOT NULL) OR ("completionState" <> 'intervention' AND "completionInterventionAt" IS NULL));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionRetryNotBefore_ck" CHECK (("completionState" IN ('retry', 'resumed') AND "completionRetryNotBefore" IS NOT NULL) OR ("completionState" NOT IN ('retry', 'resumed') AND "completionRetryNotBefore" IS NULL));

DROP INDEX IF EXISTS "StorageUpload_completionState_completionLeaseUntil_idx";
DROP INDEX IF EXISTS "StorageUpload_completionState_completionInterventionAt_idx";
DROP INDEX IF EXISTS "StorageUpload_completionState_completionRetryNotBefore_idx";
CREATE INDEX IF NOT EXISTS "StorageUpload_completionState_completionLeaseUntil_idx"
  ON "StorageUpload" ("completionState", "completionLeaseUntil");
CREATE INDEX IF NOT EXISTS "StorageUpload_completionState_completionInterventionAt_idx"
  ON "StorageUpload" ("completionState", "completionInterventionAt");
CREATE INDEX IF NOT EXISTS "StorageUpload_completionState_completionRetryNotBefore_idx"
  ON "StorageUpload" ("completionState", "completionRetryNotBefore");
ALTER TABLE "StorageUpload" SET (schema_locked = true);
