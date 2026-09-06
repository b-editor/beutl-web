import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("storage receipt migration contract", () => {
  it("preflights orphaned and duplicate completed receipts before the FK", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "apps/web/prisma/migrations/20260825170000_retain_storage_upload_receipts/migration.sql",
      ),
      "utf8",
    );
    expect(migration).toContain("completedFileId references a missing File");
    expect(migration).toContain("completedFileId contains duplicates");
    expect(migration.indexOf("RAISE EXCEPTION")).toBeLessThan(
      migration.indexOf("CREATE UNIQUE INDEX"),
    );
  });

  it("keeps completed receipts attached to File lifetime", () => {
    const schema = readFileSync(
      resolve(process.cwd(), "apps/web/prisma/schema.prisma"),
      "utf8",
    );
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "apps/web/prisma/migrations/20260825170000_retain_storage_upload_receipts/migration.sql",
      ),
      "utf8",
    );
    expect(schema).toContain("completedFileId String? @unique");
    expect(schema).toContain("onDelete: Cascade");
    expect(migration).toContain("ON DELETE CASCADE");
  });

  it("uses the Cockroach STRING type for cleanup upload identities", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "apps/web/prisma/migrations/20260825000000_add_ai_storage_cleanup_upload_id/migration.sql",
      ),
      "utf8",
    );
    expect(migration).toContain('"uploadId" STRING');
    expect(migration).not.toContain('"uploadId" TEXT');
  });
});
