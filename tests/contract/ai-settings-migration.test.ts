import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../apps/web/prisma/migrations/20260813110000_relock_ai_settings/migration.sql",
  import.meta.url,
);

describe("AI settings schema lock migration", () => {
  it("repairs the schema lock in a forward-only migration", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain(
      'ALTER TABLE "AiSetting" SET (schema_locked = true);',
    );
    expect(sql).not.toMatch(/DROP\s+TABLE/iu);
  });
});
