-- Forward repair for a migration that may have committed its table before a
-- later index or constraint statement failed. Cockroach creates new tables
-- schema-locked, so unlock before adding any of the remaining objects.
CREATE TABLE IF NOT EXISTS "PackageCheckoutResolution" (
  "id" STRING NOT NULL,
  "attemptId" STRING NOT NULL,
  "discoveryToken" STRING NOT NULL,
  "canonicalSessionId" STRING,
  "canonicalPaymentIntentId" STRING,
  "expectedRefundPaymentIntentIds" STRING NOT NULL DEFAULT '[]',
  "revision" INT4 NOT NULL DEFAULT 0,
  "operatorUserId" STRING,
  "status" STRING NOT NULL DEFAULT 'intervention',
  "evidenceJson" STRING NOT NULL,
  "lastError" STRING,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PackageCheckoutResolution_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PackageCheckoutResolution" SET (schema_locked = false);

-- Add each column independently so a table-only or column-only partial apply
-- can be repaired. A preflight rejects a wrong same-name table/column rather
-- than allowing IF NOT EXISTS to hide an incompatible schema.
ALTER TABLE "PackageCheckoutResolution" ADD COLUMN IF NOT EXISTS "id" STRING NOT NULL;
ALTER TABLE "PackageCheckoutResolution" ADD COLUMN IF NOT EXISTS "attemptId" STRING NOT NULL;
ALTER TABLE "PackageCheckoutResolution" ADD COLUMN IF NOT EXISTS "discoveryToken" STRING NOT NULL;
ALTER TABLE "PackageCheckoutResolution" ADD COLUMN IF NOT EXISTS "canonicalSessionId" STRING;
ALTER TABLE "PackageCheckoutResolution" ADD COLUMN IF NOT EXISTS "canonicalPaymentIntentId" STRING;
ALTER TABLE "PackageCheckoutResolution" ADD COLUMN IF NOT EXISTS "expectedRefundPaymentIntentIds" STRING NOT NULL DEFAULT '[]';
ALTER TABLE "PackageCheckoutResolution" ADD COLUMN IF NOT EXISTS "revision" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "PackageCheckoutResolution" ADD COLUMN IF NOT EXISTS "operatorUserId" STRING;
ALTER TABLE "PackageCheckoutResolution" ADD COLUMN IF NOT EXISTS "status" STRING NOT NULL DEFAULT 'intervention';
ALTER TABLE "PackageCheckoutResolution" ADD COLUMN IF NOT EXISTS "evidenceJson" STRING NOT NULL;
ALTER TABLE "PackageCheckoutResolution" ADD COLUMN IF NOT EXISTS "lastError" STRING;
ALTER TABLE "PackageCheckoutResolution" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "PackageCheckoutResolution" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('id', 'text', 'NO'),
      ('attemptId', 'text', 'NO'),
      ('discoveryToken', 'text', 'NO'),
      ('canonicalSessionId', 'text', 'YES'),
      ('canonicalPaymentIntentId', 'text', 'YES'),
      ('expectedRefundPaymentIntentIds', 'text', 'NO'),
      ('revision', 'int4', 'NO'),
      ('operatorUserId', 'text', 'YES'),
      ('status', 'text', 'NO'),
      ('evidenceJson', 'text', 'NO'),
      ('lastError', 'text', 'YES'),
      ('createdAt', 'timestamp', 'NO'),
      ('updatedAt', 'timestamp', 'NO')
    ) AS expected(column_name, udt_name, is_nullable)
    LEFT JOIN information_schema.columns AS actual
      ON actual.table_schema = 'public'
      AND actual.table_name = 'PackageCheckoutResolution'
      AND actual.column_name = expected.column_name
    WHERE actual.column_name IS NULL
       OR actual.udt_name <> expected.udt_name
       OR actual.is_nullable <> expected.is_nullable
  ) THEN
    RAISE EXCEPTION 'PackageCheckoutResolution has an incompatible column definition; repair it before applying this migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'PackageCheckoutResolution'
      AND constraint_type = 'PRIMARY KEY'
      AND constraint_name <> 'PackageCheckoutResolution_pkey'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.key_column_usage
    WHERE table_schema = 'public'
      AND table_name = 'PackageCheckoutResolution'
      AND constraint_name = 'PackageCheckoutResolution_pkey'
      AND column_name = 'id'
      AND ordinal_position = 1
  ) THEN
    RAISE EXCEPTION 'PackageCheckoutResolution has an incompatible primary key; repair it before applying this migration';
  END IF;
END
$$;

ALTER TABLE "PackageCheckoutResolution"
  ADD CONSTRAINT IF NOT EXISTS "PackageCheckoutResolution_pkey" PRIMARY KEY ("id");
CREATE UNIQUE INDEX IF NOT EXISTS "PackageCheckoutResolution_attemptId_discoveryToken_key"
  ON "PackageCheckoutResolution" ("attemptId", "discoveryToken");
CREATE INDEX IF NOT EXISTS "PackageCheckoutResolution_status_updatedAt_idx"
  ON "PackageCheckoutResolution" ("status", "updatedAt");
ALTER TABLE "PackageCheckoutResolution"
  ADD CONSTRAINT IF NOT EXISTS "PackageCheckoutResolution_status_check"
  CHECK ("status" IN ('intervention', 'refund_pending', 'resolved', 'terminal'));
ALTER TABLE "PackageCheckoutResolution"
  ADD CONSTRAINT IF NOT EXISTS "PackageCheckoutResolution_revision_check"
  CHECK ("revision" >= 0);

ALTER TABLE "PackageCheckoutResolution" SET (schema_locked = true);
