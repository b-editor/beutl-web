import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../apps/web/prisma/migrations/20260809133000_secure_ai_outputs/migration.sql",
  import.meta.url,
);

describe("AI output ownership migration", () => {
  it("detaches shared, cross-owner, and duplicate legacy files before enforcing ownership", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    const sharedFileGuard = sql.indexOf(
      '"File"."userId" <> "AiJob"."userId"',
    );
    const packageGuard = sql.indexOf(
      '"Package"."iconFileId" = "File"."id"',
    );
    const profileGuard = sql.indexOf(
      '"Profile"."iconFileId" = "File"."id"',
    );
    const screenshotGuard = sql.indexOf(
      '"PackageScreenshot"."fileId" = "File"."id"',
    );
    const releaseGuard = sql.indexOf(
      '"Release"."fileId" = "File"."id"',
    );
    const duplicateGuard = sql.indexOf('ROW_NUMBER() OVER');
    const uniqueIndex = sql.indexOf(
      'CREATE UNIQUE INDEX "AiJob_resultFileId_key"',
    );

    for (const guard of [
      sharedFileGuard,
      packageGuard,
      profileGuard,
      screenshotGuard,
      releaseGuard,
      duplicateGuard,
    ]) {
      expect(guard).toBeGreaterThanOrEqual(0);
      expect(guard).toBeLessThan(uniqueIndex);
    }
  });
});
