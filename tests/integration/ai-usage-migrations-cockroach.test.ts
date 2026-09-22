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
  it.each(["fresh", "recovered failure"])("preserves balances, fractions, and locks on a %s cutover", async (scenario) => {
    const schema = `ai_usage_rehearsal_${randomUUID().replaceAll("-", "")}`;
    const client = new Client({ connectionString });
    let created = false;
    try {
      await client.connect();
      await client.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TABLE "_prisma_migrations" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        migration_name STRING NOT NULL, checksum STRING NOT NULL,
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
      let injectFailure = scenario === "recovered failure";
      const completed: string[] = [];
      const deploy = async () => {
        const { rows: history } = await client.query(
          'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
        );
        const applied = new Set(history.map((row: { migration_name: string }) => row.migration_name));
        for (const migration of migrations) {
          if (applied.has(migration.name)) continue;
          const { rows: [attempt] } = await client.query(
            'INSERT INTO "_prisma_migrations" (migration_name, checksum) VALUES ($1, $2) RETURNING id',
            [migration.name, migration.checksum],
          );
          // These four migrations contain no SQL strings with semicolons.
          for (const statement of migration.sql
            .replace(/--[^\n]*/g, "")
            .split(";")
            .filter((sql: string) => sql.trim())) {
            await client.query(statement);
            if (injectFailure && migration.name === AI_USAGE_MIGRATIONS[1]) {
              injectFailure = false;
              throw new Error("Injected failure after the first billing DDL");
            }
          }
          await client.query(
            'UPDATE "_prisma_migrations" SET finished_at = now() WHERE id = $1',
            [attempt.id],
          );
          completed.push(migration.name);
        }
      };
      const run = { client, migrations, writersStopped: true, deploy };
      if (scenario === "recovered failure") {
        await expect(runAiUsageMigration(run)).rejects.toThrow("Injected failure");
        for (const table of ["AiOperationModel", "AiJob", "CreditAccount", "CreditTransaction"]) {
          const { rows } = await client.query(`SHOW CREATE TABLE "${table}"`);
          expect(rows[0].create_statement).toContain("schema_locked = true");
        }
        await expect(runAiUsageMigration(run)).rejects.toThrow("Recover failed migration");
        // Simulate operator recovery: undo the partial column addition, then
        // record the failed attempt as rolled back as migrate resolve would.
        await client.query('ALTER TABLE "AiOperationModel" SET (schema_locked = false)');
        await client.query('ALTER TABLE "AiOperationModel" DROP COLUMN "usagePercent"');
        await client.query('ALTER TABLE "AiOperationModel" SET (schema_locked = true)');
        await client.query(
          'UPDATE "_prisma_migrations" SET rolled_back_at = now() WHERE migration_name = $1 AND finished_at IS NULL',
          [AI_USAGE_MIGRATIONS[1]],
        );
      }
      const result = await runAiUsageMigration(run);
      expect(result.applied).toEqual(scenario === "fresh" ? AI_USAGE_MIGRATIONS : AI_USAGE_MIGRATIONS.slice(1));
      expect(completed).toEqual(AI_USAGE_MIGRATIONS);
      expect(
        (await client.query('SELECT COUNT(*)::INT4 AS count FROM "_prisma_migrations" WHERE migration_name = $1', [AI_USAGE_MIGRATIONS[0]])).rows[0].count,
      ).toBe(1);
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
