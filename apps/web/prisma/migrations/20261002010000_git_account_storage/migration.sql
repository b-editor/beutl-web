ALTER TABLE "GitRepository" ADD COLUMN "historyBytes" INT8 NOT NULL DEFAULT 0;
ALTER TABLE "GitRepository" ADD COLUMN "historyReservedBytes" INT8 NOT NULL DEFAULT 0;
ALTER TABLE "GitRepository" ADD COLUMN "accountedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "storageRevision" INT4 NOT NULL DEFAULT 0;

CREATE TABLE "GitLfsStorage" (
    "repoId" STRING NOT NULL,
    "oid" STRING NOT NULL,
    "ownerId" STRING NOT NULL,
    "size" INT8 NOT NULL,
    "verified" BOOL NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GitLfsStorage_pkey" PRIMARY KEY ("repoId", "oid")
);
CREATE INDEX "GitLfsStorage_ownerId_verified_idx" ON "GitLfsStorage"("ownerId", "verified");
CREATE INDEX "GitLfsStorage_verified_expiresAt_idx" ON "GitLfsStorage"("verified", "expiresAt");
