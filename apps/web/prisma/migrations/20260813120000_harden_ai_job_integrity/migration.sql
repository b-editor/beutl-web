-- Client request identity is stored as hashes so paid operations can be
-- reserved exactly once per user without retaining the opaque client key.
-- Columns stay nullable for jobs created before idempotency became mandatory.
ALTER TABLE "AiJob" SET (schema_locked = false);

ALTER TABLE "AiJob" ADD COLUMN "idempotencyKeyHash" STRING;
ALTER TABLE "AiJob" ADD COLUMN "requestFingerprint" STRING;
ALTER TABLE "AiJob" ADD COLUMN "callbackNonceHash" STRING;

ALTER TABLE "AiJob"
ADD CONSTRAINT "AiJob_idempotency_pair_check"
CHECK (
    ("idempotencyKeyHash" IS NULL AND "requestFingerprint" IS NULL)
    OR
    ("idempotencyKeyHash" IS NOT NULL AND "requestFingerprint" IS NOT NULL)
);

ALTER TABLE "AiJob"
ADD CONSTRAINT "AiJob_idempotencyKeyHash_length_check"
CHECK ("idempotencyKeyHash" IS NULL OR length("idempotencyKeyHash") = 64);

ALTER TABLE "AiJob"
ADD CONSTRAINT "AiJob_requestFingerprint_length_check"
CHECK ("requestFingerprint" IS NULL OR length("requestFingerprint") = 64);

ALTER TABLE "AiJob"
ADD CONSTRAINT "AiJob_callbackNonceHash_length_check"
CHECK ("callbackNonceHash" IS NULL OR length("callbackNonceHash") = 64);

CREATE UNIQUE INDEX "AiJob_userId_idempotencyKeyHash_key"
ON "AiJob"("userId", "idempotencyKeyHash");

-- Paid AI has not shipped, so duplicate provider IDs are not expected. Fail
-- closed on unexpected rows instead of mutating billing/audit history.
CREATE UNIQUE INDEX "AiJob_provider_providerJobId_key"
ON "AiJob"("provider", "providerJobId");

ALTER TABLE "AiJob" SET (schema_locked = true);
