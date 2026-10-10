-- Run before 20260917010000, whose checksum is already recorded in production.
-- 20260909010000 leaves "File" schema-locked, and Prisma applies migrations with
-- use_declarative_schema_changer = off; the legacy schema changer cannot unlock
-- a table by itself, so the cursor indexes fail with 57000 on a fresh chain.
-- The companion 20260917020000 migration restores the locks afterwards.
ALTER TABLE "File" SET (schema_locked = false);
ALTER TABLE "StorageFolder" SET (schema_locked = false);
