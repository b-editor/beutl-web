import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runAiUsageMigration } from "./ai-usage-migration.mjs";

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => arg !== "--check" && arg !== "--writers-stopped")) {
  throw new Error("Usage: migrate-ai-usage.mjs [--check] [--writers-stopped]");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const migrationsDirectory = new URL("../prisma/migrations/", import.meta.url);
const migrations = [];
for (const entry of (
  await readdir(migrationsDirectory, { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name))) {
  const sql = await readFile(
    new URL(`${entry.name}/migration.sql`, migrationsDirectory),
  );
  migrations.push({
    name: entry.name,
    checksum: createHash("sha256").update(sql).digest("hex"),
  });
}

const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const result = await runAiUsageMigration({
    client,
    migrations,
    writersStopped: args.has("--writers-stopped"),
    checkOnly: args.has("--check"),
    deploy: () =>
      execFileSync(
        process.execPath,
        [prismaCli, "migrate", "deploy", "--schema", "prisma/schema.prisma"],
        { cwd: appDirectory, env: process.env, stdio: "inherit" },
      ),
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.end();
}
