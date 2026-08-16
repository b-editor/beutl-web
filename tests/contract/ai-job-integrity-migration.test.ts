import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../apps/web/prisma/migrations/20260813120000_harden_ai_job_integrity/migration.sql",
  import.meta.url,
);

describe("AI job integrity migration", () => {
  it("unlocks and relocks AiJob around schema changes", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    const unlock = 'ALTER TABLE "AiJob" SET (schema_locked = false);';
    const relock = 'ALTER TABLE "AiJob" SET (schema_locked = true);';

    expect(sql.indexOf(unlock)).toBeGreaterThanOrEqual(0);
    expect(sql.lastIndexOf(relock)).toBeGreaterThan(sql.indexOf(unlock));
    expect(sql.trim().endsWith(relock)).toBe(true);
  });

  it("fails closed on unexpected duplicate provider IDs without rewriting jobs", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain(
      'CREATE UNIQUE INDEX "AiJob_provider_providerJobId_key"',
    );
    expect(sql).not.toMatch(/UPDATE\s+"AiJob"/iu);
    expect(sql).not.toContain("RankedProviderJobs");
    expect(sql).not.toContain("indeterminate");
  });
});
