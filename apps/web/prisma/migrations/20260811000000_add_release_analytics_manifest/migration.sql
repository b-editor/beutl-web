-- Bind a release to the digest of the exact package artifact and its optional
-- approved analytics manifest. Existing releases remain nullable for legacy
-- compatibility, while approvals can never exist without an artifact digest.
ALTER TABLE "Release"
ADD COLUMN "packageSha256" STRING;

ALTER TABLE "Release"
ADD COLUMN "approvedAnalyticsManifestSha256" STRING;

UPDATE "Release"
SET "packageSha256" = (
  SELECT "File"."sha256"
  FROM "File"
  WHERE "File"."id" = "Release"."fileId"
)
WHERE "fileId" IS NOT NULL;

ALTER TABLE "Release"
ADD CONSTRAINT "Release_approved_manifest_requires_file_check"
CHECK (
  "approvedAnalyticsManifestSha256" IS NULL
  OR ("fileId" IS NOT NULL AND "packageSha256" IS NOT NULL)
);

-- An approved artifact must never be detached implicitly by deleting a File.
-- Cleanup verifies all references first; this FK is the final race guard.
ALTER TABLE "Release"
DROP CONSTRAINT IF EXISTS "Release_fileId_fkey";

ALTER TABLE "Release"
ADD CONSTRAINT "Release_fileId_fkey"
FOREIGN KEY ("fileId") REFERENCES "File"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- R2 objects are removed by an idempotent outbox drainer. fileId has no FK
-- because the row is deliberately inserted before its matching File exists.
CREATE TABLE "StorageCleanup" (
  "id" STRING NOT NULL,
  "objectKey" STRING NOT NULL,
  "fileId" STRING,
  "reason" STRING NOT NULL,
  "availableAt" TIMESTAMP(3) NOT NULL,
  "leaseId" STRING,
  "leaseExpiresAt" TIMESTAMP(3),
  "attempts" INT4 NOT NULL DEFAULT 0,
  "lastErrorCode" STRING,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorageCleanup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StorageCleanup_objectKey_key" UNIQUE ("objectKey")
);

CREATE INDEX "StorageCleanup_availableAt_leaseExpiresAt_idx"
ON "StorageCleanup"("availableAt", "leaseExpiresAt");

CREATE INDEX "StorageCleanup_fileId_idx"
ON "StorageCleanup"("fileId");
