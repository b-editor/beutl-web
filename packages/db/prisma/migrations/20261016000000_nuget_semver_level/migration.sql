ALTER TABLE "Release" SET (schema_locked = false);
ALTER TABLE "Release" ADD COLUMN "nugetSemVer2" BOOL NOT NULL DEFAULT false;
-- Search counts and pagination must filter compatibility before selecting rows.
UPDATE "Release" r SET "nugetSemVer2" =
  r."version" ~ '\+|-[^+]*\.'
  OR COALESCE(r."nugetMetadata"->>'version', '') ~ '\+|-[^+]*\.'
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(r."nugetMetadata"->'dependencyGroups', '[]'::JSONB)) g,
         jsonb_array_elements(g->'dependencies') d
    WHERE d->>'range' ~ '\+|-[^+,)\]]*\.'
  );
ALTER TABLE "Release" SET (schema_locked = true);
