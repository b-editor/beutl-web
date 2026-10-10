ALTER TABLE "StorageUpload" SET (schema_locked = false);

-- Completed receipts are intentionally outside the multipart sweeper. The
-- File foreign key below bounds them by the user's file lifetime.
--
-- Both checks run before any index/FK is dropped or created. A failed check is
-- actionable: an operator must repair the data rather than losing a receipt.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "StorageUpload" AS upload
    LEFT JOIN "File" AS file ON file."id" = upload."completedFileId"
    WHERE upload."completedFileId" IS NOT NULL
      AND file."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'StorageUpload.completedFileId references a missing File; repair orphaned receipts before applying this migration';
  END IF;

  IF EXISTS (
    SELECT upload."completedFileId"
    FROM "StorageUpload" AS upload
    WHERE upload."completedFileId" IS NOT NULL
    GROUP BY upload."completedFileId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'StorageUpload.completedFileId contains duplicates; repair duplicate receipts before applying this migration';
  END IF;

  -- IF NOT EXISTS only checks an object's name. If a previous partial apply
  -- left a same-name non-unique or differently-columned index, repair it after
  -- the data preflight above instead of silently accepting the wrong index.
  IF EXISTS (
    SELECT 1
    FROM information_schema.statistics
    WHERE table_schema = 'public'
      AND table_name = 'StorageUpload'
      AND index_name = 'StorageUpload_completedFileId_key'
    GROUP BY index_name
    HAVING sum(CASE WHEN storing = 'NO' THEN 1 ELSE 0 END) <> 1
        OR max(CASE WHEN storing = 'NO'
                         AND non_unique = 'NO'
                         AND column_name = 'completedFileId'
                         AND seq_in_index = 1
                    THEN 0
                    WHEN storing = 'NO' THEN 1
                    ELSE 0 END) = 1
  ) THEN
    -- CockroachDB v26.3 does not support dynamic DDL in PL/pgSQL. The
    -- name-targeted DROP below therefore repairs this wrong definition (and
    -- is harmless when the definition is already correct).
    NULL;
  END IF;

  -- A same-name FK may be a CHECK constraint or may point at a different
  -- table/action. Verify every relevant part before retaining it; otherwise
  -- drop and recreate the definition required by the Prisma relation.
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'StorageUpload'
      AND constraint_name = 'StorageUpload_completedFileId_fkey'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.referential_constraints AS rc
    JOIN information_schema.key_column_usage AS key_column
      ON key_column.constraint_schema = rc.constraint_schema
      AND key_column.constraint_name = rc.constraint_name
      AND key_column.table_name = rc.table_name
    JOIN information_schema.constraint_column_usage AS referenced_column
      ON referenced_column.constraint_schema = rc.unique_constraint_schema
      AND referenced_column.constraint_name = rc.unique_constraint_name
    WHERE rc.constraint_schema = 'public'
      AND rc.constraint_name = 'StorageUpload_completedFileId_fkey'
      AND rc.table_name = 'StorageUpload'
      AND rc.referenced_table_name = 'File'
      AND rc.update_rule = 'CASCADE'
      AND rc.delete_rule = 'CASCADE'
      AND key_column.column_name = 'completedFileId'
      AND key_column.ordinal_position = 1
      AND referenced_column.table_name = 'File'
      AND referenced_column.column_name = 'id'
  ) THEN
    -- See the index note above; the static DROP below is the conditional-DDL
    -- equivalent supported by CockroachDB.
    NULL;
  END IF;
END
$$;

-- Name-targeted drops are deliberate: they make a wrong same-name object
-- repairable without unsupported dynamic DDL. Data was preflighted above.
DROP INDEX IF EXISTS "StorageUpload_completedFileId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "StorageUpload_completedFileId_key"
  ON "StorageUpload"("completedFileId");

ALTER TABLE "StorageUpload"
  DROP CONSTRAINT IF EXISTS "StorageUpload_completedFileId_fkey";
ALTER TABLE "StorageUpload"
  ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completedFileId_fkey"
  FOREIGN KEY ("completedFileId") REFERENCES "File"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StorageUpload" SET (schema_locked = true);
