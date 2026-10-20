-- Fresh Cockroach bootstraps can create tables with schema locking off. Lock
-- ReleaseTranslation like the other application tables so later DDL requires
-- an explicit unlock (and fails loudly instead of silently changing schema).
ALTER TABLE "ReleaseTranslation" SET (schema_locked = true);
