-- Restore the locks opened by 20260917005000 once the cursor indexes exist.
-- "StorageFolder" was left unlocked when 20260907010000 created it; lock it
-- here too so both tables end the chain schema-locked.
ALTER TABLE "File" SET (schema_locked = true);
ALTER TABLE "StorageFolder" SET (schema_locked = true);
