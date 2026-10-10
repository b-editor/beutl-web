-- Forward repair for table/index/constraint-only partial application.
CREATE TABLE IF NOT EXISTS "TopUpDuplicateRefundAttempt" (
  "id" STRING NOT NULL,
  "topUpAttemptId" STRING NOT NULL,
  "stripePaymentIntentId" STRING NOT NULL,
  "stripeCustomerId" STRING NOT NULL,
  "ownerUserId" STRING NOT NULL,
  "billingOfferId" STRING NOT NULL,
  "amount" INT4 NOT NULL,
  "currency" STRING NOT NULL,
  "status" STRING NOT NULL DEFAULT 'required',
  "notBefore" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" STRING,
  "leaseExpiresAt" TIMESTAMP(3),
  "attempts" INT4 NOT NULL DEFAULT 0,
  "refundId" STRING,
  "refundedAmount" INT4 NOT NULL DEFAULT 0,
  "lastError" STRING,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TopUpDuplicateRefundAttempt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TopUpDuplicateRefundAttempt" SET (schema_locked = false);

ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "id" STRING NOT NULL;
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "topUpAttemptId" STRING NOT NULL;
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "stripePaymentIntentId" STRING NOT NULL;
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "stripeCustomerId" STRING NOT NULL;
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "ownerUserId" STRING NOT NULL;
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "billingOfferId" STRING NOT NULL;
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "amount" INT4 NOT NULL;
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "currency" STRING NOT NULL;
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "status" STRING NOT NULL DEFAULT 'required';
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "notBefore" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "leaseToken" STRING;
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "attempts" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "refundId" STRING;
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "refundedAmount" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "lastError" STRING;
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('id', 'text', 'NO'),
      ('topUpAttemptId', 'text', 'NO'),
      ('stripePaymentIntentId', 'text', 'NO'),
      ('stripeCustomerId', 'text', 'NO'),
      ('ownerUserId', 'text', 'NO'),
      ('billingOfferId', 'text', 'NO'),
      ('amount', 'int4', 'NO'),
      ('currency', 'text', 'NO'),
      ('status', 'text', 'NO'),
      ('notBefore', 'timestamp', 'NO'),
      ('leaseToken', 'text', 'YES'),
      ('leaseExpiresAt', 'timestamp', 'YES'),
      ('attempts', 'int4', 'NO'),
      ('refundId', 'text', 'YES'),
      ('refundedAmount', 'int4', 'NO'),
      ('lastError', 'text', 'YES'),
      ('createdAt', 'timestamp', 'NO'),
      ('updatedAt', 'timestamp', 'NO')
    ) AS expected(column_name, udt_name, is_nullable)
    LEFT JOIN information_schema.columns AS actual
      ON actual.table_schema = 'public'
      AND actual.table_name = 'TopUpDuplicateRefundAttempt'
      AND actual.column_name = expected.column_name
    WHERE actual.column_name IS NULL
       OR actual.udt_name <> expected.udt_name
       OR actual.is_nullable <> expected.is_nullable
  ) THEN
    RAISE EXCEPTION 'TopUpDuplicateRefundAttempt has an incompatible column definition; repair it before applying this migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'TopUpDuplicateRefundAttempt'
      AND constraint_type = 'PRIMARY KEY'
      AND constraint_name <> 'TopUpDuplicateRefundAttempt_pkey'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.key_column_usage
    WHERE table_schema = 'public'
      AND table_name = 'TopUpDuplicateRefundAttempt'
      AND constraint_name = 'TopUpDuplicateRefundAttempt_pkey'
      AND column_name = 'id'
      AND ordinal_position = 1
  ) THEN
    RAISE EXCEPTION 'TopUpDuplicateRefundAttempt has an incompatible primary key; repair it before applying this migration';
  END IF;
END
$$;

ALTER TABLE "TopUpDuplicateRefundAttempt"
  ADD CONSTRAINT IF NOT EXISTS "TopUpDuplicateRefundAttempt_pkey" PRIMARY KEY ("id");
CREATE UNIQUE INDEX IF NOT EXISTS "TopUpDuplicateRefundAttempt_stripePaymentIntentId_key"
  ON "TopUpDuplicateRefundAttempt" ("stripePaymentIntentId");
CREATE INDEX IF NOT EXISTS "TopUpDuplicateRefundAttempt_topUpAttemptId_status_idx"
  ON "TopUpDuplicateRefundAttempt" ("topUpAttemptId", "status", "notBefore", "leaseExpiresAt");
ALTER TABLE "TopUpDuplicateRefundAttempt"
  ADD CONSTRAINT IF NOT EXISTS "TopUpDuplicateRefundAttempt_lease_pair_check"
  CHECK (("leaseToken" IS NULL AND "leaseExpiresAt" IS NULL) OR ("leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL));
ALTER TABLE "TopUpDuplicateRefundAttempt"
  ADD CONSTRAINT IF NOT EXISTS "TopUpDuplicateRefundAttempt_status_check"
  CHECK ("status" IN ('required', 'processing', 'retry', 'refunded', 'intervention'));
ALTER TABLE "TopUpDuplicateRefundAttempt"
  ADD CONSTRAINT IF NOT EXISTS "TopUpDuplicateRefundAttempt_amount_check"
  CHECK ("amount" > 0 AND "refundedAmount" >= 0 AND "refundedAmount" <= "amount");
ALTER TABLE "TopUpDuplicateRefundAttempt"
  ADD CONSTRAINT IF NOT EXISTS "TopUpDuplicateRefundAttempt_currency_check"
  CHECK (length("currency") > 0);
ALTER TABLE "TopUpDuplicateRefundAttempt"
  ADD CONSTRAINT IF NOT EXISTS "TopUpDuplicateRefundAttempt_attempts_check"
  CHECK ("attempts" >= 0);

ALTER TABLE "TopUpDuplicateRefundAttempt" SET (schema_locked = true);
