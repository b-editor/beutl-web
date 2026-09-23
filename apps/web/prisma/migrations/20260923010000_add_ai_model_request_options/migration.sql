-- A model's request behavior belongs to its admin registration, not a runtime
-- comparison against its ID. This migration is safe to replay after a failed
-- attempt: unlock, add missing columns, seed only still-default rows, relock.
ALTER TABLE "AiOperationModel" SET (schema_locked = false);

ALTER TABLE "AiOperationModel" ADD COLUMN IF NOT EXISTS "videoAudioRequired" BOOL;
ALTER TABLE "AiOperationModel" ADD COLUMN IF NOT EXISTS "imageSizeMode" STRING NOT NULL DEFAULT 'aspect_ratio';
ALTER TABLE "AiOperationModel" ADD COLUMN IF NOT EXISTS "imageOutputTokenProfile" STRING NOT NULL DEFAULT 'legacy';

-- One-time data transfer for registrations that previously depended on
-- hardcoded runtime exceptions. Future models are configured in the admin UI.
UPDATE "AiOperationModel"
SET "videoAudioRequired" = true
WHERE "provider" = 'vercel-gateway'
  AND "operation" LIKE 'video.%'
  AND "modelId" = 'minimax/minimax-h3'
  AND "videoAudioRequired" IS NULL;

UPDATE "AiOperationModel"
SET "imageOutputTokenProfile" = 'grid_48_medium'
WHERE "provider" = 'vercel-gateway'
  AND "operation" LIKE 'image.%'
  AND "modelId" IN ('openai/gpt-image-2', 'openai/gpt-image-2-2026-04-21')
  AND "imageOutputTokenProfile" = 'legacy';

UPDATE "AiOperationModel"
SET "imageSizeMode" = 'explicit_1k'
WHERE "provider" = 'vercel-gateway'
  AND "operation" = 'image.generate'
  AND "modelId" IN ('openai/gpt-image-2', 'openai/gpt-image-2-2026-04-21')
  AND "imageSizeMode" = 'aspect_ratio';

ALTER TABLE "AiOperationModel" SET (schema_locked = true);
