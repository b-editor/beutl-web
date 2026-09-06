import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
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
const prismaBin = resolve("node_modules/.bin/prisma");
execFileSync(
  prismaBin,
  ["migrate", "deploy", "--schema", "prisma/schema.prisma"],
  {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: migrationUrl },
    stdio: "inherit",
  },
);
