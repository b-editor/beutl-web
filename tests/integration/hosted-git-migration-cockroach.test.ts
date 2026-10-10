import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const requireFromWeb = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { Client } = requireFromWeb("pg");
const requireFromDb = createRequire(
  new URL("../../packages/db/package.json", import.meta.url),
);
const execFileAsync = promisify(execFile);
const connectionString = process.env.TEST_DATABASE_URL;
const describeWithCockroach = connectionString ? describe : describe.skip;

describeWithCockroach("hosted Git migration on locked Cockroach tables", () => {
  it("preserves owner relationships and restores all schema locks", async () => {
    const schema = `hosted_git_rehearsal_${randomUUID().replaceAll("-", "")}`;
    const root = await mkdtemp(join(tmpdir(), "beutl-hosted-git-migration-"));
    const client = new Client({ connectionString });
    let created = false;
    try {
      await client.connect();
      await client.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await client.query(`SET search_path TO "${schema}"`);

      const migration = await readFile(new URL(
        "../../packages/db/prisma/migrations/20261003000000_add_hosted_git/migration.sql",
        import.meta.url,
      ), "utf8");
      const migrations = join(root, "migrations");
      const initial = join(migrations, "00000000000000_test_user");
      const hostedGit = join(migrations, "20261003000000_add_hosted_git");
      await mkdir(initial, { recursive: true });
      await mkdir(hostedGit);
      await writeFile(join(migrations, "migration_lock.toml"), 'provider = "cockroachdb"\n');
      await writeFile(join(initial, "migration.sql"), `
        CREATE TABLE "User" ("id" STRING PRIMARY KEY);
        INSERT INTO "User" VALUES ('owner');
        ALTER TABLE "User" SET (schema_locked = true);
      `);
      await writeFile(join(hostedGit, "migration.sql"), migration);
      const config = join(root, "prisma.config.ts");
      await writeFile(config, `
        import { defineConfig } from ${JSON.stringify(pathToFileURL(requireFromDb.resolve("prisma/config")).href)};
        export default defineConfig({
          schema: ${JSON.stringify(fileURLToPath(new URL("../../packages/db/prisma/schema.prisma", import.meta.url)))},
          migrations: { path: ${JSON.stringify(migrations)} },
          datasource: { url: process.env.TEST_DATABASE_URL },
        });
      `);
      const url = new URL(connectionString!);
      url.searchParams.set("schema", schema);
      const runPrisma = (command: string) => execFileAsync(process.execPath, [
        requireFromDb.resolve("prisma/build/index.js"), "migrate", command, "--config", config,
      ], { env: { ...process.env, TEST_DATABASE_URL: url.toString() } });
      const status = await runPrisma("status").catch((error) => {
        if (!error.stdout) throw error;
        return error;
      });
      // Confirm the CLI targets our empty schema before allowing it to write.
      expect(status.stdout).toContain(`schema "${schema}"`);
      await runPrisma("deploy");

      expect((await client.query('SELECT "id", "storageRevision" FROM "User"')).rows)
        .toEqual([{ id: "owner", storageRevision: 0 }]);
      for (const table of ["User", "GitRepository", "GitLfsStorage"]) {
        const { rows } = await client.query(`SHOW CREATE TABLE "${table}"`);
        expect(rows[0].create_statement).toContain("schema_locked = true");
      }

      const insertRepository = (id: string, owner: string) => client.query(
        `INSERT INTO "GitRepository" ("id", "ownerId", "name", "updatedAt")
         VALUES ($1, $2, 'project', current_timestamp())`,
        [id, owner],
      );
      await expect(insertRepository("invalid", "missing-owner"))
        .rejects.toMatchObject({ code: "23503" });
      await insertRepository("repository", "owner");
      expect((await client.query(
        'SELECT "historyBytes", "historyReservedBytes", "maintenanceFailures" FROM "GitRepository"',
      )).rows).toEqual([{
        historyBytes: "0", historyReservedBytes: "0", maintenanceFailures: 0,
      }]);
      await client.query('UPDATE "User" SET "id" = $1 WHERE "id" = $2', ["renamed-owner", "owner"]);
      expect((await client.query('SELECT "ownerId" FROM "GitRepository"')).rows)
        .toEqual([{ ownerId: "renamed-owner" }]);
      await client.query('DELETE FROM "User" WHERE "id" = $1', ["renamed-owner"]);
      expect((await client.query('SELECT "id", "ownerId" FROM "GitRepository"')).rows)
        .toEqual([{ id: "repository", ownerId: null }]);

      await client.query(`INSERT INTO "GitLfsStorage"
        ("repoId", "oid", "ownerId", "size", "expiresAt")
        VALUES ('repository', 'object', 'renamed-owner', 42, current_timestamp())`);
      expect((await client.query(
        'SELECT "size", "verified", "cleanupFailures" FROM "GitLfsStorage"',
      )).rows).toEqual([{ size: "42", verified: false, cleanupFailures: 0 }]);
    } finally {
      try {
        if (created) {
          const { rows } = await client.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
            [schema],
          );
          for (const { table_name: table } of rows) {
            await client.query(`ALTER TABLE "${schema}"."${table}" SET (schema_locked = false)`);
          }
          await client.query("SET search_path TO public");
          await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        }
      } finally {
        try {
          await client.end();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }, 90_000);
});
