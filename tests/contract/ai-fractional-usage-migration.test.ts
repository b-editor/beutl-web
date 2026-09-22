import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../apps/web/prisma/migrations/20260921020000_fractional_ai_usage_units/migration.sql",
  import.meta.url,
);
const schemaUrl = new URL(
  "../../apps/web/prisma/schema.prisma",
  import.meta.url,
);

describe("fractional AI usage migration", () => {
  it("stores every balance, ledger delta, and job charge at six-place precision", async () => {
    const [migration, schema] = await Promise.all([
      readFile(migrationUrl, "utf8"),
      readFile(schemaUrl, "utf8"),
    ]);

    for (const [table, columns] of Object.entries({
      CreditAccount: [
        "monthlyUsageUsed",
        "purchasedCredits",
        "purchasedCreditDebt",
      ],
      CreditTransaction: ["creditAmount", "debtAmount", "usageAmount"],
      AiJob: ["usageUnits", "reservedUsageUnits", "estimatedUsageUnits"],
    })) {
      expect(migration).toContain(
        `ALTER TABLE "${table}" SET (schema_locked = false);`,
      );
      expect(migration).toContain(
        `ALTER TABLE "${table}" SET (schema_locked = true);`,
      );
      for (const column of columns) {
        expect(migration).toContain(
          `"${column}Decimal" DECIMAL(16, 6)`,
        );
        expect(migration).toContain(
          `RENAME COLUMN "${column}Decimal" TO "${column}";`,
        );
        expect(schema).toMatch(
          new RegExp(`\\b${column}\\s+Decimal\\??\\s+.*@db\\.Decimal\\(16, 6\\)`),
        );
      }
    }
    expect(migration).not.toContain("SET DATA TYPE");
  });
});
