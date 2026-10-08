import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationsUrl = new URL(
  "../../apps/web/prisma/migrations/",
  import.meta.url,
);

async function readMigrations() {
  const directories = await readdir(migrationsUrl, { withFileTypes: true });
  return await Promise.all(
    directories
      .filter((entry) => entry.isDirectory())
      // readdir returns whatever order the filesystem holds — sorted on APFS,
      // hash order on ext4 — and the assertions below compare ordered lists.
      // Migration names are timestamp-prefixed, so this is also apply order.
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => ({
        name: entry.name,
        sql: await readFile(
          new URL(`${entry.name}/migration.sql`, migrationsUrl),
          "utf8",
        ),
      })),
  );
}

// Split on top-level `;`, skipping comments, string literals and
// dollar-quoted bodies (`DO $$ ... $$`).
function splitStatements(sql: string) {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  while (index < sql.length) {
    const rest = sql.slice(index);
    const comment = /^--[^\n]*/.exec(rest);
    if (comment) {
      index += comment[0].length;
      continue;
    }
    const quoted =
      /^'(?:[^']|'')*'/.exec(rest) ?? /^(\$\w*\$)[\s\S]*?\1/.exec(rest);
    if (quoted) {
      current += quoted[0];
      index += quoted[0].length;
      continue;
    }
    if (sql[index] === ";") {
      statements.push(current);
      current = "";
    } else {
      current += sql[index];
    }
    index += 1;
  }
  statements.push(current);
  return statements
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// Prisma applies migrations with use_declarative_schema_changer = off, and
// Cockroach's legacy schema changer rejects DDL on a schema-locked table
// (57000) instead of unlocking it for the statement. An ALTER TABLE that adds
// a foreign key also changes the referenced table; a CREATE TABLE with an
// inline foreign key does not. Replay the lock state of the fresh-chain
// bootstrap (create_table_with_schema_locked = off) and report every table DDL
// that would run while its table is still locked.
function findDdlOnLockedTables(migrations: { name: string; sql: string }[]) {
  const locked = new Map<string, boolean>();
  const indexTables = new Map<string, string>();
  const violations: string[] = [];
  for (const { name, sql } of migrations) {
    for (const statement of splitStatements(sql)) {
      const alter = (table: string) => {
        if (locked.get(table)) violations.push(`${name}: ${table}`);
      };
      let match: RegExpExecArray | null;
      if (
        (match = /^CREATE TABLE (?:IF NOT EXISTS )?"([^"]+)"/i.exec(statement))
      ) {
        if (!locked.has(match[1])) locked.set(match[1], false);
      } else if (
        (match = /^DROP TABLE (?:IF EXISTS )?"([^"]+)"/i.exec(statement))
      ) {
        // The legacy schema changer drops a schema-locked table, and a table
        // whose foreign key references a locked one, without an unlock
        // (verified on Cockroach v26.2.5), so dropping only forgets the state.
        locked.delete(match[1]);
      } else if (
        (match =
          /^ALTER TABLE (?:IF EXISTS )?"([^"]+)" SET \(schema_locked = (true|false)\)$/i.exec(
            statement,
          ))
      ) {
        locked.set(match[1], match[2].toLowerCase() === "true");
      } else if (
        (match =
          /^ALTER TABLE (?:IF EXISTS )?"([^"]+)"(?: RENAME TO "([^"]+)")?/i.exec(
            statement,
          ))
      ) {
        alter(match[1]);
        for (const [, referenced] of statement.matchAll(
          /\bREFERENCES "([^"]+)"/gi,
        )) {
          if (referenced !== match[1]) alter(referenced);
        }
        if (match[2]) {
          locked.set(match[2], locked.get(match[1]) ?? false);
          locked.delete(match[1]);
        }
      } else if (
        (match =
          /^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"([^"]+)" ON "([^"]+)"/i.exec(
            statement,
          ))
      ) {
        indexTables.set(match[1], match[2]);
        alter(match[2]);
      } else if (
        (match = /^DROP INDEX (?:IF EXISTS )?(?:"([^"]+)"@)?"([^"]+)"/i.exec(
          statement,
        ))
      ) {
        alter(match[1] ?? indexTables.get(match[2]) ?? match[2].split("_")[0]);
      }
    }
  }
  return violations;
}

describe("Prisma migration chain", () => {
  it("defines FeedbackStatus and Feedback.status exactly once", async () => {
    const migrations = await readMigrations();

    const feedbackStatusType = migrations.filter(({ sql }) =>
      sql.includes('CREATE TYPE "FeedbackStatus"'),
    );
    const feedbackStatusColumn = migrations.filter(({ sql }) =>
      sql.includes('ALTER TABLE "Feedback" ADD COLUMN "status"'),
    );

    expect(feedbackStatusType.map(({ name }) => name)).toEqual([
      "20260810000000_add_feedback_status",
    ]);
    expect(feedbackStatusColumn.map(({ name }) => name)).toEqual([
      "20260810000000_add_feedback_status",
    ]);
  });

  it("adds the package payment amount columns exactly once", async () => {
    const migrations = await readMigrations();

    const amountColumn = migrations.filter(({ sql }) =>
      sql.includes('ADD COLUMN "stripePaymentAmount"'),
    );
    const currencyColumn = migrations.filter(({ sql }) =>
      sql.includes('ADD COLUMN "stripeCurrency"'),
    );

    // CreditTransaction gained the same pair of column names earlier, so both
    // lists are expected to hold two entries — one per table, never two per table.
    expect(amountColumn.map(({ name }) => name)).toEqual([
      "20260808120000_replace_subscription_credits_with_monthly_usage",
      "20260817000000_store_package_payment_amount",
    ]);
    expect(currencyColumn.map(({ name }) => name)).toEqual([
      "20260808120000_replace_subscription_credits_with_monthly_usage",
      "20260817000000_store_package_payment_amount",
    ]);
  });

  it("unlocks every table before Prisma runs DDL on it", async () => {
    const migrations = await readMigrations();

    expect(findDdlOnLockedTables(migrations)).toEqual([]);
    // Without the lock repair pair the replay must reproduce the fresh-chain
    // failure observed on Cockroach v26.2 (P3018 / 57000 on "File").
    expect(
      findDdlOnLockedTables(
        migrations.filter(
          ({ name }) =>
            name !== "20260917005000_unlock_storage_cursor_index_tables" &&
            name !== "20260917020000_relock_storage_cursor_index_tables",
        ),
      ),
    ).toEqual(["20260917010000_add_storage_cursor_indexes: File"]);
    // A foreign key added by ALTER TABLE needs its referenced table unlocked.
    expect(
      findDdlOnLockedTables(
        migrations.map((migration) =>
          migration.name === "20261008000000_add_subscription_grants"
            ? {
                ...migration,
                sql: migration.sql.replace(
                  'ALTER TABLE "User" SET (schema_locked = false);',
                  "",
                ),
              }
            : migration,
        ),
      ),
    ).toEqual(["20261008000000_add_subscription_grants: User"]);
  });
});
