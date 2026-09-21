import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AI_USAGE_MIGRATIONS,
  runAiUsageMigration,
} from "../../apps/web/scripts/ai-usage-migration.mjs";

const { Client } = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
)("pg");
const connectionString = process.env.TEST_DATABASE_URL;
const describeWithCockroach = connectionString ? describe : describe.skip;

describeWithCockroach("AI usage cutover on locked Cockroach tables", () => {
  it("preserves old balances, supports fractions, and finishes with every table locked", async () => {
    const schema = `ai_usage_rehearsal_${randomUUID().replaceAll("-", "")}`;
    const client = new Client({ connectionString });
    let created = false;
    try {
      await client.connect();
      await client.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TABLE "_prisma_migrations" (
        migration_name STRING PRIMARY KEY, checksum STRING NOT NULL,
        started_at TIMESTAMPTZ DEFAULT now(), finished_at TIMESTAMPTZ, rolled_back_at TIMESTAMPTZ
      )`);
      await client.query(`CREATE TABLE "AiOperationModel" (
        "operation" STRING, "modelId" STRING, PRIMARY KEY ("operation", "modelId")
      )`);
      await client.query(`CREATE TABLE "CreditAccount" (
        "userId" STRING PRIMARY KEY,
        "monthlyUsageUsed" INT8 NOT NULL DEFAULT 0,
        "purchasedCredits" INT8 NOT NULL DEFAULT 0,
        "purchasedCreditDebt" INT8 NOT NULL DEFAULT 0,
        CONSTRAINT "CreditAccount_purchasedCredits_nonnegative" CHECK ("purchasedCredits" >= 0),
        CONSTRAINT "CreditAccount_purchasedCreditDebt_nonnegative" CHECK ("purchasedCreditDebt" >= 0)
      )`);
      await client.query(`CREATE TABLE "CreditTransaction" (
        "id" STRING PRIMARY KEY, "creditAmount" INT8 NOT NULL,
        "debtAmount" INT8 NOT NULL DEFAULT 0, "usageAmount" INT8 NOT NULL DEFAULT 0
      )`);
      await client.query(`CREATE TABLE "AiJob" (
        "id" STRING PRIMARY KEY, "status" STRING NOT NULL, "usageUnits" INT8 NOT NULL
      )`);
      await client.query(
        `INSERT INTO "AiOperationModel" VALUES ('image.generate', 'review/model')`,
      );
      await client.query(
        `INSERT INTO "CreditAccount" VALUES ('review', 17, 13, 3)`,
      );
      await client.query(
        `INSERT INTO "CreditTransaction" VALUES ('review', -13, 3, 17)`,
      );
      await client.query(
        `INSERT INTO "AiJob" VALUES ('review', 'succeeded', 30)`,
      );
      for (const table of [
        "AiOperationModel",
        "AiJob",
        "CreditAccount",
        "CreditTransaction",
      ]) {
        await client.query(`ALTER TABLE "${table}" SET (schema_locked = true)`);
      }
      const migrations = await Promise.all(
        AI_USAGE_MIGRATIONS.map(async (name: string) => {
          const sql = await readFile(
            new URL(
              `../../apps/web/prisma/migrations/${name}/migration.sql`,
              import.meta.url,
            ),
            "utf8",
          );
          return {
            name,
            sql,
            checksum: createHash("sha256").update(sql).digest("hex"),
          };
        }),
      );
      const result = await runAiUsageMigration({
        client,
        migrations,
        writersStopped: true,
        deploy: async () => {
          for (const migration of migrations) {
            // These four migrations contain no SQL strings with semicolons.
            for (const statement of migration.sql
              .replace(/--[^\n]*/g, "")
              .split(";")
              .filter((sql: string) => sql.trim())) {
              await client.query(statement);
            }
            await client.query(
              `INSERT INTO "_prisma_migrations" (migration_name, checksum, finished_at) VALUES ($1, $2, now())`,
              [migration.name, migration.checksum],
            );
          }
        },
      });
      expect(result.applied).toEqual(AI_USAGE_MIGRATIONS);
      const account = await client.query(
        `SELECT "monthlyUsageUsed", "purchasedCredits", "purchasedCreditDebt" FROM "CreditAccount"`,
      );
      expect(Object.values(account.rows[0]).map(Number)).toEqual([17, 13, 3]);
      const columns = await client.query(
        `SELECT data_type, numeric_precision, numeric_scale
        FROM information_schema.columns WHERE table_schema = $1 AND column_name IN
        ('monthlyUsageUsed', 'purchasedCredits', 'purchasedCreditDebt', 'creditAmount',
         'debtAmount', 'usageAmount', 'usageUnits', 'reservedUsageUnits', 'estimatedUsageUnits')`,
        [schema],
      );
      expect(columns.rows).toHaveLength(9);
      for (const column of columns.rows) {
        expect(column.data_type).toBe("numeric");
        expect(Number(column.numeric_precision)).toBe(16);
        expect(Number(column.numeric_scale)).toBe(6);
      }
      await client.query(
        `UPDATE "CreditAccount" SET "monthlyUsageUsed" = 0.345678, "purchasedCredits" = 0.000001`,
      );
      const fractional = await client.query(
        `SELECT "monthlyUsageUsed", "purchasedCredits" FROM "CreditAccount"`,
      );
      expect(Object.values(fractional.rows[0]).map(Number)).toEqual([
        0.345678, 0.000001,
      ]);
      expect(
        (await client.query('SELECT "usagePercent" FROM "AiOperationModel"'))
          .rows[0].usagePercent,
      ).toBe(100);
    } finally {
      try {
        if (created) {
          await client.query("SET search_path TO public");
          await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        }
      } finally {
        await client.end();
      }
    }
  }, 120_000);
});
