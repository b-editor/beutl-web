-- Multipart abort and object deletion are independent remote effects. A
-- multipart handle can share objectKey with a later winning upload, so its
-- delayed cleanup must never delete the object at that key.
CREATE TABLE IF NOT EXISTS "StorageMultipartCleanup" (
  "objectKey" STRING NOT NULL,
  "uploadId" STRING NOT NULL,
  "leaseToken" STRING,
  "notBefore" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorageMultipartCleanup_pkey" PRIMARY KEY ("objectKey", "uploadId")
);

ALTER TABLE "StorageMultipartCleanup" SET (schema_locked = false);
ALTER TABLE "StorageMultipartCleanup" ADD COLUMN IF NOT EXISTS "objectKey" STRING NOT NULL;
ALTER TABLE "StorageMultipartCleanup" ADD COLUMN IF NOT EXISTS "uploadId" STRING NOT NULL;
ALTER TABLE "StorageMultipartCleanup" ADD COLUMN IF NOT EXISTS "leaseToken" STRING;
ALTER TABLE "StorageMultipartCleanup" ADD COLUMN IF NOT EXISTS "notBefore" TIMESTAMP(3) NOT NULL;
ALTER TABLE "StorageMultipartCleanup" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "StorageMultipartCleanup" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('objectKey', 'text', 'NO'),
      ('uploadId', 'text', 'NO'),
      ('leaseToken', 'text', 'YES'),
      ('notBefore', 'timestamp', 'NO'),
      ('createdAt', 'timestamp', 'NO'),
      ('updatedAt', 'timestamp', 'NO')
    ) AS expected(column_name, udt_name, is_nullable)
    LEFT JOIN information_schema.columns AS actual
      ON actual.table_schema = 'public'
      AND actual.table_name = 'StorageMultipartCleanup'
      AND actual.column_name = expected.column_name
    WHERE actual.column_name IS NULL
       OR actual.udt_name <> expected.udt_name
       OR actual.is_nullable <> expected.is_nullable
  ) THEN
    RAISE EXCEPTION 'StorageMultipartCleanup has an incompatible column definition; repair it before applying this migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'StorageMultipartCleanup'
      AND constraint_type = 'PRIMARY KEY'
      AND constraint_name <> 'StorageMultipartCleanup_pkey'
  ) OR (
    SELECT count(*)
    FROM information_schema.key_column_usage
    WHERE table_schema = 'public'
      AND table_name = 'StorageMultipartCleanup'
      AND constraint_name = 'StorageMultipartCleanup_pkey'
      AND ((column_name = 'objectKey' AND ordinal_position = 1)
        OR (column_name = 'uploadId' AND ordinal_position = 2))
  ) <> 2 THEN
    RAISE EXCEPTION 'StorageMultipartCleanup has an incompatible primary key; repair it before applying this migration';
  END IF;
END
$$;

ALTER TABLE "StorageMultipartCleanup"
  ADD CONSTRAINT IF NOT EXISTS "StorageMultipartCleanup_pkey"
  PRIMARY KEY ("objectKey", "uploadId");
DROP INDEX IF EXISTS "StorageMultipartCleanup_notBefore_idx";
CREATE INDEX IF NOT EXISTS "StorageMultipartCleanup_notBefore_idx"
  ON "StorageMultipartCleanup" ("notBefore");

-- A cleanup lease fences remote abort/delete effects from overlapping sweepers
-- and from an ABA replacement that reuses the client-supplied upload id.
ALTER TABLE "StorageUpload" SET (schema_locked = false);
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "cleanupLeaseToken" STRING;
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "cleanupLeaseUntil" TIMESTAMP(3);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('cleanupLeaseToken', 'text', 'YES'),
      ('cleanupLeaseUntil', 'timestamp', 'YES')
    ) AS expected(column_name, udt_name, is_nullable)
    LEFT JOIN information_schema.columns AS actual
      ON actual.table_schema = 'public'
      AND actual.table_name = 'StorageUpload'
      AND actual.column_name = expected.column_name
    WHERE actual.column_name IS NULL
       OR actual.udt_name <> expected.udt_name
       OR actual.is_nullable <> expected.is_nullable
  ) THEN
    RAISE EXCEPTION 'StorageUpload has an incompatible cleanup lease column; repair it before applying this migration';
  END IF;
END
$$;

DROP INDEX IF EXISTS "StorageUpload_abandonedAt_cleanupLeaseUntil_idx";
CREATE INDEX IF NOT EXISTS "StorageUpload_abandonedAt_cleanupLeaseUntil_idx"
  ON "StorageUpload" ("abandonedAt", "cleanupLeaseUntil");
ALTER TABLE "StorageUpload"
  DROP CONSTRAINT IF EXISTS "StorageUpload_cleanupLease_pair_ck";
ALTER TABLE "StorageUpload"
  ADD CONSTRAINT IF NOT EXISTS "StorageUpload_cleanupLease_pair_ck"
  CHECK (("cleanupLeaseToken" IS NULL AND "cleanupLeaseUntil" IS NULL)
    OR ("cleanupLeaseToken" IS NOT NULL AND "cleanupLeaseUntil" IS NOT NULL AND "abandonedAt" IS NOT NULL));

-- Move handles written by the old combined cleanup model. Keep this DML in a
-- catalog guard so replay remains safe after the legacy column is dropped.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'AiStorageCleanup'
      AND column_name = 'uploadId'
  ) THEN
    INSERT INTO "StorageMultipartCleanup"
      ("objectKey", "uploadId", "leaseToken", "notBefore", "createdAt", "updatedAt")
    SELECT
      "objectKey",
      "uploadId",
      NULL,
      "notBefore",
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM "AiStorageCleanup"
    WHERE "uploadId" IS NOT NULL AND "uploadId" <> ''
    ON CONFLICT ("objectKey", "uploadId") DO NOTHING;
  END IF;
END
$$;

-- The former orphan representation used a zero-sized abandoned StorageUpload
-- row with a random id. Detach those handles before their User FK can cascade.
INSERT INTO "StorageMultipartCleanup"
  ("objectKey", "uploadId", "leaseToken", "notBefore", "createdAt", "updatedAt")
SELECT
  "objectKey",
  "uploadId",
  NULL,
  COALESCE("abandonedAt", CURRENT_TIMESTAMP),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "StorageUpload"
WHERE "size" = 0
  AND "completedFileId" IS NULL
  AND "abandonedAt" IS NOT NULL
  AND "uploadId" IS NOT NULL
  AND "uploadId" <> ''
ON CONFLICT ("objectKey", "uploadId") DO NOTHING;

DELETE FROM "StorageUpload"
WHERE "size" = 0
  AND "completedFileId" IS NULL
  AND "abandonedAt" IS NOT NULL
  AND "uploadId" IS NOT NULL
  AND "uploadId" <> '';

ALTER TABLE "AiStorageCleanup" SET (schema_locked = false);
-- Keep the nullable physical column so this forward-repair SQL remains safely
-- replayable on CockroachDB, whose PL/pgSQL validates a guarded statement's
-- column references before entering the branch. The application schema no
-- longer exposes the column, and the check makes the object-only contract
-- mechanical for every writer.
UPDATE "AiStorageCleanup" SET "uploadId" = NULL WHERE "uploadId" IS NOT NULL;
ALTER TABLE "AiStorageCleanup"
  ADD CONSTRAINT IF NOT EXISTS "AiStorageCleanup_uploadId_retired_ck"
  CHECK ("uploadId" IS NULL);
ALTER TABLE "AiStorageCleanup" SET (schema_locked = true);
ALTER TABLE "StorageUpload" SET (schema_locked = true);
ALTER TABLE "StorageMultipartCleanup" SET (schema_locked = true);
