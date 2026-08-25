-- An unfinished multipart upload has parts in R2 that only its uploadId can
-- abort. The cleanup row needs to carry that id so the sweeper can abort it
-- after the StorageUpload row — which held it — is gone with the user.
ALTER TABLE "AiStorageCleanup" SET (schema_locked = false);
ALTER TABLE "AiStorageCleanup" ADD COLUMN IF NOT EXISTS "uploadId" TEXT;
ALTER TABLE "AiStorageCleanup" SET (schema_locked = true);
