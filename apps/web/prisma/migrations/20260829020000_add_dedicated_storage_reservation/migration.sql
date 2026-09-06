-- Dedicated developer artifacts reserve the same bytes and file slot as
-- multipart uploads before the object is written. Keep this forward-only and
-- replayable for Cockroach rolling deployment.
ALTER TABLE "StorageUpload" SET (schema_locked = false);
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "reservationKind" STRING NOT NULL DEFAULT 'multipart';
UPDATE "StorageUpload" SET "reservationKind" = 'multipart' WHERE "reservationKind" IS NULL;
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_reservationKind_ck";
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_reservationKind_ck"
  CHECK ("reservationKind" IN ('multipart', 'dedicated'));
-- Dedicated reservations intentionally have no remote multipart upload id and
-- use their own terminal start state. Repair the earlier multipart-only checks
-- so the new row can be inserted before R2 put.
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_startState_ck";
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_startState_uploadId_ck";
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_creationLease_ck";
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_completionLease_pair_ck";
ALTER TABLE "StorageUpload" DROP CONSTRAINT IF EXISTS "StorageUpload_completionIntervention_ck";
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_startState_ck"
  CHECK ("startState" IN ('intent', 'creating', 'active', 'dedicated'));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_startState_uploadId_ck"
  CHECK (("reservationKind" = 'dedicated' AND "startState" = 'dedicated' AND "uploadId" IS NULL)
      OR ("reservationKind" = 'multipart' AND (("startState" IN ('intent', 'creating') AND "uploadId" IS NULL)
      OR ("startState" = 'active' AND "uploadId" IS NOT NULL))));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_creationLease_ck"
  CHECK (("reservationKind" = 'multipart' AND
          (("startState" = 'creating' AND "creationLeaseUntil" IS NOT NULL AND "creationLeaseToken" IS NOT NULL)
           OR ("startState" <> 'creating' AND "creationLeaseUntil" IS NULL AND "creationLeaseToken" IS NULL)))
      OR ("reservationKind" = 'dedicated' AND "startState" = 'dedicated' AND
          (("completedFileId" IS NULL AND "abandonedAt" IS NULL AND
            "creationLeaseUntil" IS NOT NULL AND "creationLeaseToken" IS NOT NULL)
           OR (("completedFileId" IS NOT NULL OR "abandonedAt" IS NOT NULL) AND
               "creationLeaseUntil" IS NULL AND "creationLeaseToken" IS NULL))));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionLease_pair_ck"
  CHECK (("reservationKind" = 'multipart' AND
          (("completionState" = 'idle' AND "completionLeaseToken" IS NULL AND "completionLeaseUntil" IS NULL)
           OR ("completionState" = 'completing' AND "completionLeaseToken" IS NOT NULL AND "completionLeaseUntil" IS NOT NULL)
           OR ("completionState" IN ('retry', 'resumed', 'settled', 'intervention', 'unknown') AND "completionLeaseToken" IS NULL AND "completionLeaseUntil" IS NULL)))
      OR ("reservationKind" = 'dedicated' AND
          (("completionState" = 'completing' AND "completionLeaseToken" IS NOT NULL AND "completionLeaseUntil" IS NOT NULL)
           OR ("completionState" IN ('idle', 'settled', 'unknown') AND "completionLeaseToken" IS NULL AND "completionLeaseUntil" IS NULL))));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionIntervention_ck"
  CHECK (("reservationKind" = 'multipart' AND
          (("completionState" IN ('intervention', 'unknown') AND "completionInterventionAt" IS NOT NULL)
           OR ("completionState" NOT IN ('intervention', 'unknown') AND "completionInterventionAt" IS NULL)))
      OR ("reservationKind" = 'dedicated' AND
          (("completionState" = 'unknown' AND "completionInterventionAt" IS NOT NULL)
           OR ("completionState" <> 'unknown' AND "completionInterventionAt" IS NULL))));
CREATE INDEX IF NOT EXISTS "StorageUpload_userId_reservationKind_completedFileId_idx"
  ON "StorageUpload" ("userId", "reservationKind", "completedFileId");
ALTER TABLE "StorageUpload" SET (schema_locked = true);
