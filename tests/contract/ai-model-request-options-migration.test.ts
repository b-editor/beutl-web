import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../apps/web/prisma/migrations/20260923010000_add_ai_model_request_options/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("per-model request options migration", () => {
  it("unlocks and relocks the registered-model table around replayable DDL", () => {
    const unlock = migration.indexOf('ALTER TABLE "AiOperationModel" SET (schema_locked = false)');
    const firstColumn = migration.indexOf('ADD COLUMN IF NOT EXISTS "videoAudioRequired"');
    const relock = migration.lastIndexOf('ALTER TABLE "AiOperationModel" SET (schema_locked = true)');
    expect(unlock).toBeGreaterThanOrEqual(0);
    expect(firstColumn).toBeGreaterThan(unlock);
    expect(relock).toBeGreaterThan(migration.indexOf("grid_48_medium"));
  });

  it("preserves existing registrations without runtime model-ID checks", () => {
    expect(migration).toContain("'minimax/minimax-h3'");
    expect(migration).toContain("'openai/gpt-image-2'");
    expect(migration).toContain("'openai/gpt-image-2-2026-04-21'");
    expect(migration).toContain('"videoAudioRequired" IS NULL');
    expect(migration).toContain('"imageSizeMode" = \'aspect_ratio\'');
    expect(migration).toContain('"imageOutputTokenProfile" = \'legacy\'');
    const tokenBackfill = migration.slice(
      migration.indexOf('SET "imageOutputTokenProfile"'),
      migration.indexOf('SET "imageSizeMode"'),
    );
    expect(tokenBackfill).not.toContain('"provider"');
    const videoParser = readFileSync(
      new URL("../../packages/api/src/ai/providers/vercel-gateway/models.ts", import.meta.url),
      "utf8",
    );
    const imageGeometry = readFileSync(
      new URL("../../packages/api/src/ai/image-output-geometry.ts", import.meta.url),
      "utf8",
    );
    expect(videoParser).not.toContain("minimax/minimax-h3");
    expect(imageGeometry).not.toContain("openai/gpt-image-2");
  });
});
