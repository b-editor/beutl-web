ALTER TABLE "StorageUpload" SET (schema_locked = false);

ALTER TABLE "StorageUpload" ALTER COLUMN "uploadId" DROP NOT NULL;
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "startState" STRING NOT NULL DEFAULT 'active';
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "creationLeaseUntil" TIMESTAMP(3);
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "creationLeaseToken" STRING;
ALTER TABLE "StorageUpload" ALTER COLUMN "startState" SET DEFAULT 'intent';

CREATE INDEX IF NOT EXISTS "StorageUpload_startState_creationLeaseUntil_idx"
  ON "StorageUpload"("startState", "creationLeaseUntil");

ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_startState_ck"
  CHECK ("startState" IN ('intent', 'creating', 'active'));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_startState_uploadId_ck"
  CHECK (("startState" IN ('intent', 'creating') AND "uploadId" IS NULL)
      OR ("startState" = 'active' AND "uploadId" IS NOT NULL));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_creationLease_ck"
  CHECK (("startState" = 'creating' AND "creationLeaseUntil" IS NOT NULL AND "creationLeaseToken" IS NOT NULL)
      OR ("startState" <> 'creating' AND "creationLeaseUntil" IS NULL AND "creationLeaseToken" IS NULL));

ALTER TABLE "StorageUpload" SET (schema_locked = true);
