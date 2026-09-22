-- Finish the cutover for both newly upgraded databases and development
-- databases that already applied 20260921010000/20260921020000 manually.
ALTER TABLE "AiOperationModel" SET (schema_locked = true);
ALTER TABLE "AiJob" SET (schema_locked = true);
ALTER TABLE "CreditAccount" SET (schema_locked = true);
ALTER TABLE "CreditTransaction" SET (schema_locked = true);
