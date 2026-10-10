-- Preserve published identities and casing. Existing duplicates must be
-- resolved by their owners/operators; do not choose an owner by row order.
-- Run the preflight before unlocking so a refused migration changes nothing.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "Profile"
    GROUP BY lower("userName") HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Profile has duplicate case-insensitive user names; resolve the conflicting identities before retrying this migration';
  END IF;
END $$;

ALTER TABLE "Profile" SET (schema_locked = false);
CREATE UNIQUE INDEX IF NOT EXISTS "Profile_userName_lower_key"
  ON "Profile" (lower("userName"));
ALTER TABLE "Profile" SET (schema_locked = true);
