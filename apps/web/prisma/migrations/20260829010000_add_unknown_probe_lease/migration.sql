ALTER TABLE "StorageUpload" SET (schema_locked = false);
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "unknownProbeNotBefore" TIMESTAMP(3);
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "unknownProbeLeaseToken" STRING;
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_unknownProbeLease_pair_ck";
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_unknownProbeLease_pair_ck"
  CHECK (("completionState" = 'unknown' AND (("unknownProbeLeaseToken" IS NULL AND "unknownProbeNotBefore" IS NULL)
      OR ("unknownProbeLeaseToken" IS NOT NULL AND "unknownProbeNotBefore" IS NOT NULL)))
      OR ("completionState" <> 'unknown' AND "unknownProbeLeaseToken" IS NULL AND "unknownProbeNotBefore" IS NULL));
CREATE INDEX IF NOT EXISTS "StorageUpload_completionState_unknownProbeNotBefore_idx"
  ON "StorageUpload" ("completionState", "unknownProbeNotBefore");
ALTER TABLE "StorageUpload" SET (schema_locked = true);
