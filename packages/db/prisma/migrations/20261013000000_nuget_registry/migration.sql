-- Stop before changing schema if existing IDs differ only by case.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Package" GROUP BY lower("name") HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Package has duplicate case-insensitive IDs; resolve their ownership before retrying';
  END IF;
END $$;
ALTER TABLE "Package" SET (schema_locked = false);
ALTER TABLE "Release" SET (schema_locked = false);
ALTER TABLE "User" SET (schema_locked = false);
CREATE TYPE "PackageAudience" AS ENUM ('USER', 'DEVELOPMENT');
ALTER TABLE "Package" ADD COLUMN "audience" "PackageAudience" NOT NULL DEFAULT 'USER';
CREATE UNIQUE INDEX "Package_name_lower_key" ON "Package" (lower("name"));
ALTER TABLE "Release" ADD COLUMN "artifactLocked" BOOL NOT NULL DEFAULT false;
ALTER TABLE "Release" ADD COLUMN "nugetListed" BOOL NOT NULL DEFAULT true;
ALTER TABLE "Release" ADD COLUMN "nugetVersion" STRING;
ALTER TABLE "Release" ADD COLUMN "nugetMetadata" JSONB;
ALTER TABLE "Release" ADD COLUMN "nuspec" STRING;
ALTER TABLE "Release" ADD COLUMN "readme" STRING;
ALTER TABLE "Release" ADD COLUMN "downloads" INT8 NOT NULL DEFAULT 0;
-- Current unpublished releases are explicitly treated as never published.
UPDATE "Release" SET "artifactLocked" = true WHERE "published" = true;
CREATE UNIQUE INDEX "Release_packageId_nugetVersion_key" ON "Release" ("packageId", "nugetVersion");
CREATE TABLE "PublishedPackageVersion" (
  "name" STRING NOT NULL,
  "version" STRING NOT NULL,
  "releaseId" STRING NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PublishedPackageVersion_pkey" PRIMARY KEY ("name", "version")
);
ALTER TABLE "PublishedPackageVersion" SET (schema_locked = false);
CREATE UNIQUE INDEX "PublishedPackageVersion_releaseId_key" ON "PublishedPackageVersion" ("releaseId");
CREATE TABLE "NugetToken" (
  "id" STRING NOT NULL,
  "userId" STRING NOT NULL,
  "name" STRING NOT NULL,
  "tokenHash" STRING NOT NULL,
  "hint" STRING NOT NULL,
  "canPush" BOOL NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "NugetToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NugetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
ALTER TABLE "NugetToken" SET (schema_locked = false);
CREATE UNIQUE INDEX "NugetToken_tokenHash_key" ON "NugetToken" ("tokenHash");
CREATE INDEX "NugetToken_userId_idx" ON "NugetToken" ("userId");

-- Existing Web versions are strict SemVer. Reserve currently published identities only.
INSERT INTO "PublishedPackageVersion" ("name", "version", "releaseId")
SELECT lower(p."name"), lower(split_part(r."version", '+', 1)), r."id"
FROM "Release" r JOIN "Package" p ON p."id" = r."packageId"
WHERE r."published" = true;

ALTER TABLE "Package" SET (schema_locked = true);
ALTER TABLE "Release" SET (schema_locked = true);
ALTER TABLE "User" SET (schema_locked = true);
ALTER TABLE "PublishedPackageVersion" SET (schema_locked = true);
ALTER TABLE "NugetToken" SET (schema_locked = true);
