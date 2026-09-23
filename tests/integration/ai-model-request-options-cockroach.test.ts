import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const { Client } = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
)("pg");
const connectionString = process.env.TEST_DATABASE_URL;
const describeWithCockroach = connectionString ? describe : describe.skip;

describeWithCockroach("per-model request options on locked Cockroach tables", () => {
  it("seeds current registrations, preserves unknown models, and can be retried", async () => {
    const schema = `ai_model_options_rehearsal_${randomUUID().replaceAll("-", "")}`;
    const client = new Client({ connectionString });
    let created = false;
    try {
      await client.connect();
      await client.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TABLE "AiOperationModel" (
        "operation" STRING NOT NULL,
        "modelId" STRING NOT NULL,
        "provider" STRING NOT NULL,
        PRIMARY KEY ("operation", "modelId")
      )`);
      await client.query(`INSERT INTO "AiOperationModel" ("operation", "modelId", "provider") VALUES
        ('video.generate', 'minimax/minimax-h3', 'vercel-gateway'),
        ('image.generate', 'openai/gpt-image-2', 'vercel-gateway'),
        ('image.edit.remove_object', 'openai/gpt-image-2', 'openrouter'),
        ('image.edit.restyle', 'openai/gpt-image-2', 'vercel-gateway'),
        ('image.generate', 'example/other-image', 'vercel-gateway')`);
      await client.query('ALTER TABLE "AiOperationModel" SET (schema_locked = true)');

      const sql = await readFile(new URL(
        "../../apps/web/prisma/migrations/20260923010000_add_ai_model_request_options/migration.sql",
        import.meta.url,
      ), "utf8");
      const statements = sql.replace(/--[^\n]*/g, "").split(";").filter((part) => part.trim());
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const statement of statements) await client.query(statement);
      }

      const { rows } = await client.query(`SELECT "operation", "modelId",
        "videoAudioRequired", "imageSizeMode", "imageOutputTokenProfile"
        FROM "AiOperationModel" ORDER BY "operation", "modelId"`);
      expect(rows).toEqual([
        { operation: "image.edit.remove_object", modelId: "openai/gpt-image-2", videoAudioRequired: null,
          imageSizeMode: "aspect_ratio", imageOutputTokenProfile: "grid_48_medium" },
        { operation: "image.edit.restyle", modelId: "openai/gpt-image-2", videoAudioRequired: null,
          imageSizeMode: "aspect_ratio", imageOutputTokenProfile: "grid_48_medium" },
        { operation: "image.generate", modelId: "example/other-image", videoAudioRequired: null,
          imageSizeMode: "aspect_ratio", imageOutputTokenProfile: "legacy" },
        { operation: "image.generate", modelId: "openai/gpt-image-2", videoAudioRequired: null,
          imageSizeMode: "explicit_1k", imageOutputTokenProfile: "grid_48_medium" },
        { operation: "video.generate", modelId: "minimax/minimax-h3", videoAudioRequired: true,
          imageSizeMode: "aspect_ratio", imageOutputTokenProfile: "legacy" },
      ]);
      const { rows: create } = await client.query('SHOW CREATE TABLE "AiOperationModel"');
      expect(create[0].create_statement).toContain("schema_locked = true");
    } finally {
      if (created) {
        await client.query("SET search_path TO public");
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
      await client.end();
    }
  }, 90_000);
});
