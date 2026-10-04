-- Long-lived Git access tokens. The repository foreign key also changes the
-- referenced GitRepository table, so both tables are unlocked for the change.
CREATE TABLE "GitAccessToken" (
  "id" STRING NOT NULL, "repoId" STRING NOT NULL, "ownerId" STRING NOT NULL,
  "name" STRING NOT NULL, "scope" STRING NOT NULL, "tokenHash" STRING NOT NULL, "hint" STRING NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3),
  CONSTRAINT "GitAccessToken_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "GitAccessToken" SET (schema_locked = false);
ALTER TABLE "GitRepository" SET (schema_locked = false);
CREATE UNIQUE INDEX "GitAccessToken_tokenHash_key" ON "GitAccessToken"("tokenHash");
CREATE INDEX "GitAccessToken_repoId_revokedAt_idx" ON "GitAccessToken"("repoId", "revokedAt");
ALTER TABLE "GitAccessToken" ADD CONSTRAINT "GitAccessToken_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "GitRepository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GitRepository" SET (schema_locked = true);
ALTER TABLE "GitAccessToken" SET (schema_locked = true);
