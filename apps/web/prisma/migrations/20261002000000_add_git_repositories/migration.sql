CREATE TABLE "GitRepository" (
    "id" STRING NOT NULL,
    "ownerId" STRING,
    "name" STRING NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "cleanupCompleteAt" TIMESTAMP(3),
    CONSTRAINT "GitRepository_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GitRepository_ownerId_deletedAt_idx" ON "GitRepository"("ownerId", "deletedAt");
CREATE INDEX "GitRepository_deletedAt_cleanupCompleteAt_idx" ON "GitRepository"("deletedAt", "cleanupCompleteAt");
ALTER TABLE "GitRepository" ADD CONSTRAINT "GitRepository_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
