ALTER TABLE "GitRepository" SET (schema_locked = false);
ALTER TABLE "GitLfsStorage" SET (schema_locked = false);
ALTER TABLE "GitRepository"
  ADD COLUMN "maintenanceAttemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "maintenanceFailures" INT4 NOT NULL DEFAULT 0;

ALTER TABLE "GitLfsStorage"
  ADD COLUMN "cleanupAttemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "cleanupFailures" INT4 NOT NULL DEFAULT 0;

CREATE INDEX "GitRepository_maintenanceAttemptedAt_idx" ON "GitRepository"("maintenanceAttemptedAt");
CREATE INDEX "GitLfsStorage_cleanupAttemptedAt_idx" ON "GitLfsStorage"("cleanupAttemptedAt");
ALTER TABLE "GitRepository" SET (schema_locked = true);
ALTER TABLE "GitLfsStorage" SET (schema_locked = true);
