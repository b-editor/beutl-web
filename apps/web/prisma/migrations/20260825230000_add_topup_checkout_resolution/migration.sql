-- Forward repair for table/index/constraint-only partial application.
CREATE TABLE IF NOT EXISTS "TopUpCheckoutResolution" (
  "id" STRING NOT NULL,
  "topUpAttemptId" STRING NOT NULL,
  "ownerUserId" STRING NOT NULL,
  "stripeCustomerId" STRING NOT NULL,
  "billingOfferId" STRING NOT NULL,
  "canonicalSessionId" STRING,
  "expectedPaymentIntentIds" STRING NOT NULL,
  "status" STRING NOT NULL DEFAULT 'refund_pending',
  "revision" INT4 NOT NULL DEFAULT 0,
  "lastError" STRING,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TopUpCheckoutResolution_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TopUpCheckoutResolution" SET (schema_locked = false);

ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "id" STRING NOT NULL;
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "topUpAttemptId" STRING NOT NULL;
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "ownerUserId" STRING NOT NULL;
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "stripeCustomerId" STRING NOT NULL;
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "billingOfferId" STRING NOT NULL;
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "canonicalSessionId" STRING;
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "expectedPaymentIntentIds" STRING NOT NULL;
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "status" STRING NOT NULL DEFAULT 'refund_pending';
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "revision" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "lastError" STRING;
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "TopUpCheckoutResolution" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('id', 'text', 'NO'),
      ('topUpAttemptId', 'text', 'NO'),
      ('ownerUserId', 'text', 'NO'),
      ('stripeCustomerId', 'text', 'NO'),
      ('billingOfferId', 'text', 'NO'),
      ('canonicalSessionId', 'text', 'YES'),
      ('expectedPaymentIntentIds', 'text', 'NO'),
      ('status', 'text', 'NO'),
      ('revision', 'int4', 'NO'),
      ('lastError', 'text', 'YES'),
      ('createdAt', 'timestamp', 'NO'),
      ('updatedAt', 'timestamp', 'NO')
    ) AS expected(column_name, udt_name, is_nullable)
    LEFT JOIN information_schema.columns AS actual
      ON actual.table_schema = 'public'
      AND actual.table_name = 'TopUpCheckoutResolution'
      AND actual.column_name = expected.column_name
    WHERE actual.column_name IS NULL
       OR actual.udt_name <> expected.udt_name
       OR actual.is_nullable <> expected.is_nullable
  ) THEN
    RAISE EXCEPTION 'TopUpCheckoutResolution has an incompatible column definition; repair it before applying this migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'TopUpCheckoutResolution'
      AND constraint_type = 'PRIMARY KEY'
      AND constraint_name <> 'TopUpCheckoutResolution_pkey'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.key_column_usage
    WHERE table_schema = 'public'
      AND table_name = 'TopUpCheckoutResolution'
      AND constraint_name = 'TopUpCheckoutResolution_pkey'
      AND column_name = 'id'
      AND ordinal_position = 1
  ) THEN
    RAISE EXCEPTION 'TopUpCheckoutResolution has an incompatible primary key; repair it before applying this migration';
  END IF;
END
$$;

ALTER TABLE "TopUpCheckoutResolution"
  ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutResolution_pkey" PRIMARY KEY ("id");
CREATE UNIQUE INDEX IF NOT EXISTS "TopUpCheckoutResolution_topUpAttemptId_key"
  ON "TopUpCheckoutResolution" ("topUpAttemptId");
ALTER TABLE "TopUpCheckoutResolution"
  ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutResolution_status_check"
  CHECK ("status" IN ('refund_pending', 'intervention', 'resolved', 'terminal'));
ALTER TABLE "TopUpCheckoutResolution"
  ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutResolution_revision_check"
  CHECK ("revision" >= 0);

ALTER TABLE "TopUpCheckoutResolution" SET (schema_locked = true);
