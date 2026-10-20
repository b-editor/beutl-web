-- The table is schema-locked (as the other translation table is after its
-- creation), so open it for this additive column and restore the lock.
ALTER TABLE "PackageTranslation" SET (schema_locked = false);

ALTER TABLE "PackageTranslation" ADD COLUMN "displayName" STRING;

ALTER TABLE "PackageTranslation" SET (schema_locked = true);
