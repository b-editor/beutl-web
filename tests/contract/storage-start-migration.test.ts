import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const migrationPath =
  "../../apps/web/prisma/migrations/20260825160000_durable_storage_upload_start/migration.sql";
const repairPath =
  "../../apps/web/prisma/migrations/20260826000000_repair_storage_upload_start_default/migration.sql";
const IMMUTABLE_MIGRATION_SHA256 =
  "9f41da3afecacedb55a946cb93a04c28721d11ca0445818fb43e32072d60c1d0";

describe("durable storage-upload start migration contract", () => {
  it("preserves the applied 1600 migration and its maintenance-window contract", async () => {
    const migration = await readFile(new URL(migrationPath, import.meta.url), "utf8");
    expect(createHash("sha256").update(migration).digest("hex")).toBe(
      IMMUTABLE_MIGRATION_SHA256,
    );
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "startState" STRING NOT NULL DEFAULT \'active\'',
    );
    expect(migration).toContain('ALTER COLUMN "startState" SET DEFAULT \'intent\'');
    expect(migration).toContain(
      'CHECK (("startState" IN (\'intent\', \'creating\') AND "uploadId" IS NULL)',
    );
    expect(migration).toContain(
      'OR ("startState" = \'active\' AND "uploadId" IS NOT NULL))',
    );
  });

  it("ships a forward-only repair for the post-maintenance default", async () => {
    const repair = await readFile(new URL(repairPath, import.meta.url), "utf8");
    expect(repair).toContain('ALTER COLUMN "startState" SET DEFAULT \'active\'');
    expect(repair).toContain("schema_locked = false");
    expect(repair).toContain("schema_locked = true");
  });

  it("keeps the Prisma model aligned with the repaired database default", async () => {
    const schema = await readFile(
      new URL("../../apps/web/prisma/schema.prisma", import.meta.url),
      "utf8",
    );
    const model = schema.slice(
      schema.indexOf("model StorageUpload"),
      schema.indexOf("model Package"),
    );
    expect(model).toContain('startState      String   @default("active")');
  });
});
