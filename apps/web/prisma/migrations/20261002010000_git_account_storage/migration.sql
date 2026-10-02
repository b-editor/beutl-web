ALTER TABLE "GitRepository" SET (schema_locked = false);
ALTER TABLE "User" SET (schema_locked = false);
ALTER TABLE "GitRepository" ADD COLUMN "historyBytes" INT8 NOT NULL DEFAULT 0;
ALTER TABLE "GitRepository" ADD COLUMN "historyReservedBytes" INT8 NOT NULL DEFAULT 0;
ALTER TABLE "GitRepository" ADD COLUMN "accountedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "storageRevision" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "GitRepository" SET (schema_locked = true);
ALTER TABLE "User" SET (schema_locked = true);

CREATE TABLE "GitLfsStorage" (
    "repoId" STRING NOT NULL,
    "oid" STRING NOT NULL,
    "ownerId" STRING NOT NULL,
    "size" INT8 NOT NULL,
    "verified" BOOL NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GitLfsStorage_pkey" PRIMARY KEY ("repoId", "oid")
);
ALTER TABLE "GitLfsStorage" SET (schema_locked = false);
CREATE INDEX "GitLfsStorage_ownerId_verified_idx" ON "GitLfsStorage"("ownerId", "verified");
CREATE INDEX "GitLfsStorage_verified_expiresAt_idx" ON "GitLfsStorage"("verified", "expiresAt");
ALTER TABLE "GitLfsStorage" SET (schema_locked = true);
