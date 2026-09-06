-- Forward-only repair for environments where the durable-start migration was
-- already applied with an intent default. Keep the database-first rollout
-- compatible with old writers that omit startState and provide uploadId.
ALTER TABLE "StorageUpload" SET (schema_locked = false);

ALTER TABLE "StorageUpload" ALTER COLUMN "startState" SET DEFAULT 'active';

ALTER TABLE "StorageUpload" SET (schema_locked = true);
