-- Validate identities before any schema change. Legacy Web versions are SemVer,
-- optionally prefixed with v; build metadata and prerelease case are not identity.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Package" WHERE length("name") > 100 OR "name" !~ '^[A-Za-z0-9_]+([._-][A-Za-z0-9_]+)*$') THEN
    RAISE EXCEPTION 'Package has unsupported legacy IDs; resolve the IDs described in docs/deployment.md before retrying';
  END IF;
  IF EXISTS (SELECT 1 FROM "Package" GROUP BY lower("name") HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Package has duplicate case-insensitive IDs; resolve their ownership before retrying';
  END IF;
  -- The previous Web form accepted three-part SemVer, but allowed longer
  -- strings and larger numeric components than NuGet can read.
  IF EXISTS (
    SELECT 1 FROM "Release"
    WHERE CASE
      WHEN length("version") > 128 OR "version" !~ '^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' THEN true
      ELSE split_part(regexp_replace("version", '^v', ''), '.', 1)::DECIMAL > 2147483647
        OR split_part("version", '.', 2)::DECIMAL > 2147483647
        OR split_part(split_part(split_part("version", '.', 3), '-', 1), '+', 1)::DECIMAL > 2147483647
    END
  ) THEN
    RAISE EXCEPTION 'Release has unsupported legacy versions; resolve the versions described in docs/deployment.md before retrying';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "Release"
    GROUP BY "packageId", lower(regexp_replace(split_part("version", '+', 1), '^v', ''))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Release has duplicate normalized versions; resolve the collisions described in docs/deployment.md before retrying';
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
-- Backfill drafts too, so filtering and the unique index use the same identity.
UPDATE "Release" SET "nugetVersion" = lower(regexp_replace(split_part("version", '+', 1), '^v', ''));
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

-- Reserve currently published identities only, using the canonical backfill above.
INSERT INTO "PublishedPackageVersion" ("name", "version", "releaseId")
SELECT lower(p."name"), r."nugetVersion", r."id"
FROM "Release" r JOIN "Package" p ON p."id" = r."packageId"
WHERE r."published" = true;

ALTER TABLE "Package" SET (schema_locked = true);
ALTER TABLE "Release" SET (schema_locked = true);
ALTER TABLE "User" SET (schema_locked = true);
ALTER TABLE "PublishedPackageVersion" SET (schema_locked = true);
ALTER TABLE "NugetToken" SET (schema_locked = true);
