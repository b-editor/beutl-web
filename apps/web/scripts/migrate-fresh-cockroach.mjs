import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { withFreshCockroachMigrationOption } from "./cockroach-migration-url.mjs";
import { assertFreshCockroachDatabase } from "./fresh-cockroach-preflight.mjs";
import pg from "pg";

const { Client } = pg;

const freshDatabaseUrl = process.env.FRESH_COCKROACH_DATABASE_URL;
if (!freshDatabaseUrl) {
  throw new Error(
    "FRESH_COCKROACH_DATABASE_URL is required; this command must target a dedicated empty Cockroach database",
  );
}

const migrationUrl = withFreshCockroachMigrationOption(freshDatabaseUrl);
const client = new Client({ connectionString: freshDatabaseUrl });
try {
  await client.connect();
  await assertFreshCockroachDatabase(client);
} catch (error) {
  if (error instanceof Error && error.message.startsWith("FRESH_COCKROACH_DATABASE_URL")) {
    throw error;
  }
  throw new Error(
    "Unable to verify FRESH_COCKROACH_DATABASE_URL; refusing to run migrations",
  );
} finally {
  await client.end().catch(() => undefined);
}
const requireFromDb = createRequire(
  new URL("../../../packages/db/package.json", import.meta.url),
);
const prismaCli = requireFromDb.resolve("prisma/build/index.js");
const prismaConfig = fileURLToPath(
  new URL("../../../packages/db/prisma.config.ts", import.meta.url),
);
execFileSync(
  process.execPath,
  [prismaCli, "migrate", "deploy", "--config", prismaConfig],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, DATABASE_URL: migrationUrl },
    stdio: "inherit",
  },
);
