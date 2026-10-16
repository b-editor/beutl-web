ALTER TABLE "Release" SET (schema_locked = false);
ALTER TABLE "Release" ADD COLUMN "nugetMetadataInvalid" BOOL NOT NULL DEFAULT false;
ALTER TABLE "Release" SET (schema_locked = true);
