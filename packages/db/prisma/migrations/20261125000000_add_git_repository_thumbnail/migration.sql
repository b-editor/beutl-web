-- The table is schema-locked after its creation, so open it for this additive
-- column and restore the lock.
ALTER TABLE "GitRepository" SET (schema_locked = false);

ALTER TABLE "GitRepository" ADD COLUMN "thumbnailUpdatedAt" TIMESTAMP(3);

ALTER TABLE "GitRepository" SET (schema_locked = true);
