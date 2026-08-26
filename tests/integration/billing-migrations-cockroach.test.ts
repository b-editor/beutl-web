import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const connectionString = process.env.TEST_DATABASE_URL;
const describeWithCockroach = connectionString ? describe : describe.skip;

const migrationFiles = [
  "20260825170000_retain_storage_upload_receipts",
  "20260825210000_add_package_checkout_resolution",
  "20260825220000_add_topup_duplicate_refund_attempt",
  "20260825230000_add_topup_checkout_resolution",
] as const;

type TargetMigration = (typeof migrationFiles)[number];

const targetTables: Record<TargetMigration, string> = {
  "20260825170000_retain_storage_upload_receipts": "StorageUpload",
  "20260825210000_add_package_checkout_resolution":
    "PackageCheckoutResolution",
  "20260825220000_add_topup_duplicate_refund_attempt":
    "TopUpDuplicateRefundAttempt",
  "20260825230000_add_topup_checkout_resolution": "TopUpCheckoutResolution",
};

function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let inDollarQuote = false;
  let inLineComment = false;

  for (let i = 0; i < sql.length; i++) {
    const current = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      if (current === "\n") inLineComment = false;
      continue;
    }
    if (!quote && !inDollarQuote && current === "-" && next === "-") {
      inLineComment = true;
      i++;
      continue;
    }
    if (!inDollarQuote && current === "'") {
      if (quote === "'" && next === "'") {
        i++;
        continue;
      }
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (!inDollarQuote && current === '"') {
      if (quote === '"' && next === '"') {
        i++;
        continue;
      }
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (!quote && current === "$" && next === "$") {
      inDollarQuote = !inDollarQuote;
      i++;
      continue;
    }
    if (!quote && !inDollarQuote && current === ";") {
      const statement = sql.slice(start, i + 1).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }

  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

async function migrationSql(name: TargetMigration): Promise<string> {
  return readFile(
    new URL(`../../apps/web/prisma/migrations/${name}/migration.sql`, import.meta.url),
    "utf8",
  );
}

async function runSql(prisma: PrismaClient, sql: string): Promise<void> {
  for (const statement of splitSql(sql)) {
    await prisma.$executeRawUnsafe(statement);
  }
}

async function createDatabase(): Promise<{
  prisma: PrismaClient;
  database: string;
  admin: PrismaClient;
}> {
  const base = new URL(connectionString!);
  const adminUrl = new URL(base);
  adminUrl.pathname = "/defaultdb";
  const database = `codex_migration_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const admin = new PrismaClient({
    adapter: new PrismaPg({ connectionString: adminUrl.toString() }),
  });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" CASCADE`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  const databaseUrl = new URL(base);
  databaseUrl.pathname = `/${database}`;
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl.toString() }),
  });
  return { prisma, database, admin };
}

async function dropDatabase(
  prisma: PrismaClient,
  admin: PrismaClient,
  database: string,
): Promise<void> {
  await prisma.$disconnect();
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" CASCADE`);
  await admin.$disconnect();
}

async function createReceiptBase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'CREATE TABLE "File" ("id" STRING PRIMARY KEY)',
  );
  await prisma.$executeRawUnsafe(
    'CREATE TABLE "StorageUpload" ("id" STRING PRIMARY KEY, "completedFileId" STRING)',
  );
}

describeWithCockroach(
  "Cockroach migration repair integration (set TEST_DATABASE_URL to run)",
  () => {
    const resources: Array<{
      prisma: PrismaClient;
      admin: PrismaClient;
      database: string;
    }> = [];

    afterAll(async () => {
      for (const resource of resources.splice(0)) {
        await dropDatabase(resource.prisma, resource.admin, resource.database);
      }
    });

    it("applies the clean chain twice", async () => {
      const resource = await createDatabase();
      resources.push(resource);
      await createReceiptBase(resource.prisma);
      for (const name of migrationFiles) await runSql(resource.prisma, await migrationSql(name));
      for (const name of migrationFiles) await runSql(resource.prisma, await migrationSql(name));

      const tables = await resource.prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name IN ('StorageUpload', 'PackageCheckoutResolution', 'TopUpDuplicateRefundAttempt', 'TopUpCheckoutResolution')`,
      );
      expect(tables.map((row) => row.table_name).sort()).toEqual([
        "PackageCheckoutResolution",
        "StorageUpload",
        "TopUpCheckoutResolution",
        "TopUpDuplicateRefundAttempt",
      ]);
    }, 120_000);

    it("blocks old writers until maintenance repair, then accepts them", async () => {
      const resource = await createDatabase();
      resources.push(resource);
      await resource.prisma.$executeRawUnsafe(
        'CREATE TABLE "StorageUpload" ("id" STRING PRIMARY KEY, "uploadId" STRING NOT NULL)',
      );
      const startMigration = await readFile(
        new URL(
          "../../apps/web/prisma/migrations/20260825160000_durable_storage_upload_start/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await runSql(resource.prisma, startMigration);
      await expect(
        resource.prisma.$executeRawUnsafe(
          'INSERT INTO "StorageUpload" ("id", "uploadId") VALUES (\'old-writer-1\', \'remote-1\')',
        ),
      ).rejects.toThrow();

      const repairMigration = await readFile(
        new URL(
          "../../apps/web/prisma/migrations/20260826000000_repair_storage_upload_start_default/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await runSql(resource.prisma, repairMigration);
      await resource.prisma.$executeRawUnsafe(
        'INSERT INTO "StorageUpload" ("id", "uploadId", "startState") VALUES (\'new-writer-intent\', NULL, \'intent\')',
      );
      await resource.prisma.$executeRawUnsafe(
        'INSERT INTO "StorageUpload" ("id", "uploadId") VALUES (\'old-writer-2\', \'remote-2\')',
      );
      const [afterRepair] = await resource.prisma.$queryRawUnsafe<
        Array<{ startState: string }>
      >('SELECT "startState" FROM "StorageUpload" WHERE "id" = \'old-writer-2\'');
      expect(afterRepair?.startState).toBe("active");
    }, 120_000);

    it.each(["table-only", "index-only", "constraint-only"] as const)(
      "repairs %s partial table state for every new resolution table",
      async (state) => {
        const resource = await createDatabase();
        resources.push(resource);
        await createReceiptBase(resource.prisma);

        for (const name of migrationFiles.slice(1)) {
          const table = targetTables[name];
          const statements = splitSql(await migrationSql(name));
          const create = statements.find((statement) =>
            statement.includes("CREATE TABLE IF NOT EXISTS"),
          );
          const unlock = statements.find((statement) =>
            statement.includes("SET (schema_locked = false)"),
          );
          const indexes = statements.filter((statement) =>
            /^CREATE (UNIQUE )?INDEX IF NOT EXISTS/.test(statement),
          );
          const constraints = statements.filter((statement) =>
            statement.includes("ADD CONSTRAINT IF NOT EXISTS"),
          );
          expect(create).toBeDefined();
          expect(unlock).toBeDefined();
          expect(indexes.length).toBeGreaterThan(0);
          expect(constraints.length).toBeGreaterThan(0);

          await resource.prisma.$executeRawUnsafe(create!);
          if (state !== "table-only") {
            await resource.prisma.$executeRawUnsafe(unlock!);
            for (const index of indexes) await resource.prisma.$executeRawUnsafe(index);
          }
          if (state === "constraint-only") {
            await resource.prisma.$executeRawUnsafe(constraints[0]);
          }
          await runSql(resource.prisma, await migrationSql(name));

          const [{ count }] = await resource.prisma.$queryRawUnsafe<
            Array<{ count: bigint }>
          >(
            `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
            table,
          );
          expect(Number(count)).toBe(1);
        }
      },
      120_000,
    );

    it("repairs wrong same-name receipt index and foreign key definitions", async () => {
      const resource = await createDatabase();
      resources.push(resource);
      await createReceiptBase(resource.prisma);
      await resource.prisma.$executeRawUnsafe(
        'CREATE TABLE "WrongReceiptTarget" ("id" STRING PRIMARY KEY)',
      );
      await resource.prisma.$executeRawUnsafe(
        'ALTER TABLE "StorageUpload" SET (schema_locked = false)',
      );
      await resource.prisma.$executeRawUnsafe(
        'CREATE INDEX "StorageUpload_completedFileId_key" ON "StorageUpload"("completedFileId")',
      );
      await resource.prisma.$executeRawUnsafe(
        'ALTER TABLE "StorageUpload" ADD CONSTRAINT "StorageUpload_completedFileId_fkey" FOREIGN KEY ("completedFileId") REFERENCES "WrongReceiptTarget"("id") ON DELETE NO ACTION ON UPDATE NO ACTION',
      );
      await resource.prisma.$executeRawUnsafe(
        'INSERT INTO "File" ("id") VALUES (\'file-repair\')',
      );
      await resource.prisma.$executeRawUnsafe(
        'INSERT INTO "WrongReceiptTarget" ("id") VALUES (\'file-repair\')',
      );
      await resource.prisma.$executeRawUnsafe(
        'INSERT INTO "StorageUpload" ("id", "completedFileId") VALUES (\'upload-repair\', \'file-repair\')',
      );

      await runSql(
        resource.prisma,
        await migrationSql("20260825170000_retain_storage_upload_receipts"),
      );

      const [index] = await resource.prisma.$queryRawUnsafe<
        Array<{ non_unique: string; column_name: string }>
      >(
        `SELECT non_unique, column_name FROM information_schema.statistics
         WHERE table_schema = 'public' AND table_name = 'StorageUpload'
           AND index_name = 'StorageUpload_completedFileId_key' AND storing = 'NO'`,
      );
      expect(index).toEqual({ non_unique: "NO", column_name: "completedFileId" });
      const [foreignKey] = await resource.prisma.$queryRawUnsafe<
        Array<{ referenced_table_name: string; update_rule: string; delete_rule: string }>
      >(
        `SELECT referenced_table_name, update_rule, delete_rule
         FROM information_schema.referential_constraints
         WHERE constraint_schema = 'public' AND constraint_name = 'StorageUpload_completedFileId_fkey'`,
      );
      expect(foreignKey).toEqual({
        referenced_table_name: "File",
        update_rule: "CASCADE",
        delete_rule: "CASCADE",
      });
    }, 120_000);
  },
);
