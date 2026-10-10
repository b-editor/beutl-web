ALTER TYPE "ConfirmationTokenPurpose" ADD VALUE 'EMAIL_UPDATE_APPROVAL';

ALTER TABLE "ConfirmationToken" SET (schema_locked = false);
ALTER TABLE "Session" SET (schema_locked = false);
ALTER TABLE "ConfirmationToken" ADD COLUMN "sessionId" STRING;
ALTER TABLE "ConfirmationToken" ADD COLUMN "sourceEmail" STRING;
CREATE INDEX "ConfirmationToken_sessionId_idx" ON "ConfirmationToken"("sessionId");
ALTER TABLE "ConfirmationToken" ADD CONSTRAINT "ConfirmationToken_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Previously issued email-change links lack session and original-mailbox proof.
DELETE FROM "ConfirmationToken" WHERE "purpose" = 'EMAIL_UPDATE';
ALTER TABLE "Session" SET (schema_locked = true);
ALTER TABLE "ConfirmationToken" SET (schema_locked = true);

CREATE TABLE "AuthEmailRateLimit" (
  "key" STRING NOT NULL,
  "count" INT4 NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthEmailRateLimit_pkey" PRIMARY KEY ("key")
);
ALTER TABLE "AuthEmailRateLimit" SET (schema_locked = false);
CREATE INDEX "AuthEmailRateLimit_expiresAt_idx" ON "AuthEmailRateLimit"("expiresAt");
ALTER TABLE "AuthEmailRateLimit" SET (schema_locked = true);
