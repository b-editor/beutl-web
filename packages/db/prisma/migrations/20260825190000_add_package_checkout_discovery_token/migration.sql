ALTER TABLE "PackageCheckoutAttempt" SET (schema_locked = false);
ALTER TABLE "PackageCheckoutAttempt" ADD COLUMN IF NOT EXISTS "discoveryToken" STRING DEFAULT gen_random_uuid()::STRING;
UPDATE "PackageCheckoutAttempt" SET "discoveryToken" = gen_random_uuid()::STRING WHERE "discoveryToken" IS NULL;
ALTER TABLE "PackageCheckoutAttempt" ALTER COLUMN "discoveryToken" SET NOT NULL;
ALTER TABLE "PackageCheckoutAttempt" ALTER COLUMN "discoveryToken" SET DEFAULT gen_random_uuid()::STRING;
CREATE UNIQUE INDEX IF NOT EXISTS "PackageCheckoutAttempt_discoveryToken_key" ON "PackageCheckoutAttempt" ("discoveryToken");
ALTER TABLE "PackageCheckoutAttempt" SET (schema_locked = true);
