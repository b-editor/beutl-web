-- Make multipart cleanup attempts durable and operator-visible. Existing rows
-- remain retryable and start with zero attempts.
ALTER TABLE "StorageMultipartCleanup" SET (schema_locked = false);
ALTER TABLE "StorageMultipartCleanup" ADD COLUMN IF NOT EXISTS "attempts" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "StorageMultipartCleanup" ADD COLUMN IF NOT EXISTS "lastError" STRING;
ALTER TABLE "StorageMultipartCleanup" ADD COLUMN IF NOT EXISTS "interventionAt" TIMESTAMP(3);
ALTER TABLE "StorageMultipartCleanup" ADD COLUMN IF NOT EXISTS "status" STRING NOT NULL DEFAULT 'pending';
ALTER TABLE "StorageMultipartCleanup" ADD COLUMN IF NOT EXISTS "revision" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "StorageMultipartCleanup" ADD COLUMN IF NOT EXISTS "operatorUserId" STRING;
ALTER TABLE "StorageMultipartCleanup" ADD COLUMN IF NOT EXISTS "operatorReason" STRING;
ALTER TABLE "StorageMultipartCleanup" ADD COLUMN IF NOT EXISTS "operatorEvidence" STRING;
ALTER TABLE "StorageMultipartCleanup" ADD COLUMN IF NOT EXISTS "terminalizedAt" TIMESTAMP(3);
UPDATE "StorageMultipartCleanup" SET "status" = 'pending' WHERE "status" IS NULL;
ALTER TABLE "StorageMultipartCleanup" DROP CONSTRAINT IF EXISTS "StorageMultipartCleanup_status_ck";
ALTER TABLE "StorageMultipartCleanup" ADD CONSTRAINT IF NOT EXISTS "StorageMultipartCleanup_status_ck"
  CHECK ("status" IN ('pending', 'processing', 'retry', 'intervention', 'terminal'));
DROP INDEX IF EXISTS "StorageMultipartCleanup_notBefore_idx";
CREATE INDEX IF NOT EXISTS "StorageMultipartCleanup_status_notBefore_idx"
  ON "StorageMultipartCleanup" ("status", "notBefore");
CREATE INDEX IF NOT EXISTS "StorageMultipartCleanup_intervention_idx"
  ON "StorageMultipartCleanup" ("status", "interventionAt");
CREATE INDEX IF NOT EXISTS "StorageMultipartCleanup_objectKey_status_idx"
  ON "StorageMultipartCleanup" ("objectKey", "status");
ALTER TABLE "StorageMultipartCleanup" SET (schema_locked = true);
