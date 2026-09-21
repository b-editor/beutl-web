-- Which provider serves a registered model, and which model a cleanup belongs to.
--
-- Written forward-only and re-runnable, unlocking and re-locking the schema
-- around each table, the way every other migration against a live Cockroach
-- table in this chain is written: a locked table rejects DDL outright, and a
-- rolling deploy can run the same file twice.

-- AiOperationModel."provider" defaults to the one provider that existed, so every
-- row already registered keeps running where it ran. The primary key stays
-- (operation, modelId): a request names a model and never a provider, so a model
-- id has to resolve to exactly one row.
ALTER TABLE "AiOperationModel" SET (schema_locked = false);
ALTER TABLE "AiOperationModel" ADD COLUMN IF NOT EXISTS "provider" STRING NOT NULL DEFAULT 'openrouter';
ALTER TABLE "AiOperationModel" SET (schema_locked = true);

-- Nullable: rows written before this column exist, and OpenRouter never needs it.
-- A provider that addresses a job by model as well as by id cannot reconcile a
-- deleted account's remote job without it.
ALTER TABLE "AiRemoteJobCleanup" SET (schema_locked = false);
ALTER TABLE "AiRemoteJobCleanup" ADD COLUMN IF NOT EXISTS "model" STRING;
ALTER TABLE "AiRemoteJobCleanup" SET (schema_locked = true);
