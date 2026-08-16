-- The original AiSetting migration unlocked the table to add its foreign key
-- but did not restore CockroachDB schema locking. Keep the applied migration
-- immutable and repair the table in a forward-only migration.
ALTER TABLE "AiSetting" SET (schema_locked = true);
