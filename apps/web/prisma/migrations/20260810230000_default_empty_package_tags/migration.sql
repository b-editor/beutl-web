-- The store now derives a package's kind from reserved entries in "tags", and asking
-- for extensions means "carries none of the reserved tags". Prisma expresses that as
-- NOT (tags && reserved), which a SQL NULL array never satisfies — a package created
-- before this migration (createDevPackage never wrote the column) would silently
-- vanish from the extension listing. Backfill those rows and give the column the
-- empty-array default so the negative predicate stays total from here on.

-- The empty-array literal is written as a string: an empty ARRAY[] constructor has no
-- inferable element type in CockroachDB, while '{}' is cast implicitly.

-- AlterTable
UPDATE "Package" SET "tags" = '{}'::text[] WHERE "tags" IS NULL;

ALTER TABLE "Package" ALTER COLUMN "tags" SET DEFAULT '{}'::text[];
