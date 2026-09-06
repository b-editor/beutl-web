-- Provider status reads are guarded by an atomic lease so concurrent client
-- polling and scheduled reconciliation do not fan out duplicate requests.
ALTER TABLE "AiJob" ADD COLUMN "providerPollLeaseExpiresAt" TIMESTAMP(3);
