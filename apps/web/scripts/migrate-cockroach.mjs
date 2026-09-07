// Prisma Migrate against an existing Cockroach database.
//
//   status    print `prisma migrate status` for MIGRATE_DATABASE_URL
//   diff      SQL that would bring MIGRATE_DATABASE_URL in line with prisma/migrations
//   baseline  record the history as applied on a database that got it by hand
//   deploy    `prisma migrate deploy`, refusing a database with no history
//
// The target is always MIGRATE_DATABASE_URL. DATABASE_URL from .env is the
// developer database and is never used as a target, so a forgotten variable
// fails instead of migrating the wrong cluster.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import {
  MigrationHistoryError,
  assertDistinctDatabase,
  driftFingerprint,
  inspectMigrationHistory,
  planBaseline,
  readMigrationNames,
  redactConnectionStrings,
  unlockPublicTables,
} from "./cockroach-migration-history.mjs";
import { withFreshCockroachMigrationOption } from "./cockroach-migration-url.mjs";

const { Client } = pg;
const migrationsDir = resolve("prisma/migrations");
const prismaBin = resolve("node_modules/.bin/prisma");

function requireEnv(name, purpose) {
  const value = process.env[name];
  if (!value) {
    throw new MigrationHistoryError(`${name} is required; ${purpose}`);
  }
  return value;
}

function targetUrl() {
  return requireEnv(
    "MIGRATE_DATABASE_URL",
    "set it to the database that should receive the migration history. DATABASE_URL from .env is never used as a target",
  );
}

function shadowUrl(target) {
  const shadow = requireEnv(
    "MIGRATE_SHADOW_DATABASE_URL",
    "the drift check replays prisma/migrations into a disposable Cockroach database",
  );
  assertDistinctDatabase(shadow, [
    ["MIGRATE_DATABASE_URL", target],
    ["DATABASE_URL", process.env.DATABASE_URL],
  ]);
  return shadow;
}

/** Run the Prisma CLI; `capture` returns stdout instead of streaming it. */
function runPrisma(args, { database, shadow, capture = false }) {
  // prisma.config.ts loads .env through dotenv, which fills in every variable
  // that is not already set, so unsetting one here would not hide it. Only an
  // explicit value steers the CLI; the developer shadow database stays visible
  // to the commands that never touch a shadow database.
  const env = { ...process.env, DATABASE_URL: database };
  if (shadow) {
    env.SHADOW_DATABASE_URL = shadow;
  }
  const result = spawnSync(prismaBin, args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

async function withClient(label, url, fn) {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch {
    throw new MigrationHistoryError(
      `Unable to connect to ${label}; refusing to continue`,
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Replay the history into the shadow database and compare the target to it.
 * `code` is the exit code of `prisma migrate diff --exit-code`: 0 in sync,
 * 2 drift, anything else an error. The drift SQL is echoed for review and
 * identified by a fingerprint an operator can hand back to `baseline`.
 */
async function diffAgainstHistory({ target, shadow, migrations }) {
  const unlocked = await withClient(
    "MIGRATE_SHADOW_DATABASE_URL",
    shadow,
    unlockPublicTables,
  );
  if (unlocked > 0) {
    console.log(`Unlocked ${unlocked} leftover shadow tables for the replay`);
  }
  console.log(
    `Replaying ${readMigrationNames(migrations).length} migrations into the shadow database; on CockroachDB Cloud every statement is a schema-change job, so expect 20 minutes or more (progress: SHOW JOBS on the shadow database)`,
  );
  const { status, stdout } = runPrisma(
    [
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-migrations",
      migrations,
      "--script",
      "--exit-code",
    ],
    {
      database: target,
      shadow: withFreshCockroachMigrationOption(shadow),
      capture: true,
    },
  );
  process.stdout.write(stdout);
  const fingerprint = status === 2 ? driftFingerprint(stdout) : undefined;
  if (fingerprint) {
    console.log(`Drift fingerprint: ${fingerprint}`);
  }
  return { code: status, fingerprint };
}

/** Replay only part of the history by copying it into a scratch directory. */
async function withMigrationSubset(selected, fn) {
  if (selected.length === readMigrationNames(migrationsDir).length) {
    return fn(migrationsDir);
  }
  const dir = mkdtempSync(join(tmpdir(), "beutl-migrations-"));
  try {
    cpSync(
      join(migrationsDir, "migration_lock.toml"),
      join(dir, "migration_lock.toml"),
    );
    for (const name of selected) {
      cpSync(join(migrationsDir, name), join(dir, name), { recursive: true });
    }
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function status() {
  return runPrisma(["migrate", "status"], { database: targetUrl() }).status;
}

async function diff() {
  const target = targetUrl();
  const shadow = shadowUrl(target);
  const { code } = await diffAgainstHistory({
    target,
    shadow,
    migrations: migrationsDir,
  });
  if (code === 0) {
    console.log("MIGRATE_DATABASE_URL matches prisma/migrations.");
  } else if (code === 2) {
    console.error(
      "MIGRATE_DATABASE_URL differs from prisma/migrations; the SQL above would bring it in line.",
    );
  }
  return code;
}

async function baseline() {
  const target = targetUrl();
  const shadow = shadowUrl(target);
  const through = process.env.MIGRATE_BASELINE_THROUGH || undefined;
  const acceptedDrift = process.env.MIGRATE_BASELINE_ACCEPT_DRIFT || undefined;
  const names = readMigrationNames(migrationsDir);
  const history = await withClient(
    "MIGRATE_DATABASE_URL",
    target,
    inspectMigrationHistory,
  );
  const plan = planBaseline({ names, history, through });
  if (plan.alreadyRecorded.length > 0) {
    console.log(
      `${plan.alreadyRecorded.length} migrations are already recorded and will be kept`,
    );
  }
  if (plan.pending.length === 0) {
    console.log("Nothing to baseline.");
    return runPrisma(["migrate", "status"], { database: target }).status;
  }

  console.log(
    `Checking that MIGRATE_DATABASE_URL matches the ${plan.selected.length} selected migrations before recording them`,
  );
  const drift = await withMigrationSubset(plan.selected, (migrations) =>
    diffAgainstHistory({ target, shadow, migrations }),
  );
  if (drift.code === 2) {
    if (acceptedDrift === drift.fingerprint) {
      console.log(
        `Accepting the reviewed drift ${drift.fingerprint}; the history is recorded although MIGRATE_DATABASE_URL keeps the differences above.`,
      );
    } else if (acceptedDrift) {
      console.error(
        `Refusing to baseline: MIGRATE_BASELINE_ACCEPT_DRIFT names drift ${acceptedDrift}, but the current drift is ${drift.fingerprint}. Review the SQL above again before accepting it.`,
      );
      return 2;
    } else {
      console.error(
        `Refusing to baseline: MIGRATE_DATABASE_URL differs from the selected migrations. Apply the SQL above by hand, or set MIGRATE_BASELINE_THROUGH to the last migration that really was applied, then rerun. To keep exactly this difference and record the history anyway, rerun with MIGRATE_BASELINE_ACCEPT_DRIFT=${drift.fingerprint}.`,
      );
      return 2;
    }
  } else if (drift.code !== 0) {
    console.error("Refusing to baseline: the drift check did not complete.");
    return 1;
  }

  for (const name of plan.pending) {
    console.log(`Recording ${name} as applied`);
    const resolved = runPrisma(["migrate", "resolve", "--applied", name], {
      database: target,
    }).status;
    if (resolved !== 0) {
      console.error(
        `prisma migrate resolve failed for ${name}; rerun baseline to continue from that migration`,
      );
      return resolved;
    }
  }
  return runPrisma(["migrate", "status"], { database: target }).status;
}

async function deploy() {
  const target = targetUrl();
  const history = await withClient(
    "MIGRATE_DATABASE_URL",
    target,
    inspectMigrationHistory,
  );
  if (history.applied.length === 0) {
    throw new MigrationHistoryError(
      "MIGRATE_DATABASE_URL records no applied migrations; run migrate:baseline (existing schema) or migrate:fresh-cockroach (empty database) first",
    );
  }
  return runPrisma(["migrate", "deploy"], { database: target }).status;
}

const commands = { status, diff, baseline, deploy };
const command = commands[process.argv[2]];
if (!command) {
  console.error(
    "usage: node scripts/migrate-cockroach.mjs <status|diff|baseline|deploy>",
  );
  process.exit(1);
}

command().then(
  (code) => process.exit(code),
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(redactConnectionStrings(message));
    process.exit(1);
  },
);
