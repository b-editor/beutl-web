-- Adding the owner foreign key also changes the referenced User table.
ALTER TABLE "User" SET (schema_locked = false);
ALTER TABLE "User" ADD COLUMN "storageRevision" INT4 NOT NULL DEFAULT 0;

CREATE TABLE "GitRepository" (
  "id" STRING NOT NULL, "ownerId" STRING, "name" STRING NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, "deletedAt" TIMESTAMP(3), "cleanupCompleteAt" TIMESTAMP(3),
  "historyBytes" INT8 NOT NULL DEFAULT 0, "historyReservedBytes" INT8 NOT NULL DEFAULT 0,
  "maintenanceAttemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "maintenanceFailures" INT4 NOT NULL DEFAULT 0,
  CONSTRAINT "GitRepository_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "GitRepository" SET (schema_locked = false);
CREATE INDEX "GitRepository_ownerId_deletedAt_idx" ON "GitRepository"("ownerId", "deletedAt");
CREATE INDEX "GitRepository_deletedAt_cleanupCompleteAt_idx" ON "GitRepository"("deletedAt", "cleanupCompleteAt");
CREATE INDEX "GitRepository_maintenanceAttemptedAt_idx" ON "GitRepository"("maintenanceAttemptedAt");
ALTER TABLE "GitRepository" ADD CONSTRAINT "GitRepository_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "User" SET (schema_locked = true);
ALTER TABLE "GitRepository" SET (schema_locked = true);

CREATE TABLE "GitLfsStorage" (
  "repoId" STRING NOT NULL, "oid" STRING NOT NULL, "ownerId" STRING NOT NULL, "size" INT8 NOT NULL,
  "verified" BOOL NOT NULL DEFAULT false, "expiresAt" TIMESTAMP(3) NOT NULL,
  "cleanupAttemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cleanupFailures" INT4 NOT NULL DEFAULT 0,
  CONSTRAINT "GitLfsStorage_pkey" PRIMARY KEY ("repoId", "oid")
);
ALTER TABLE "GitLfsStorage" SET (schema_locked = false);
CREATE INDEX "GitLfsStorage_ownerId_verified_idx" ON "GitLfsStorage"("ownerId", "verified");
CREATE INDEX "GitLfsStorage_verified_expiresAt_idx" ON "GitLfsStorage"("verified", "expiresAt");
CREATE INDEX "GitLfsStorage_cleanupAttemptedAt_idx" ON "GitLfsStorage"("cleanupAttemptedAt");
ALTER TABLE "GitLfsStorage" SET (schema_locked = true);
