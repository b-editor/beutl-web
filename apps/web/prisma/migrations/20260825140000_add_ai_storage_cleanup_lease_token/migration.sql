-- A sweeper claim is a lease over the cleanup row. The token lets every
-- remote-storage acknowledgement finalize only the row it actually claimed.
ALTER TABLE "AiStorageCleanup" SET (schema_locked = false);
ALTER TABLE "AiStorageCleanup" ADD COLUMN IF NOT EXISTS "leaseToken" STRING;
ALTER TABLE "AiStorageCleanup" SET (schema_locked = true);
