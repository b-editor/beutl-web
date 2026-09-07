import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HISTORY_TABLE = "_prisma_migrations";

export class MigrationHistoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrationHistoryError";
  }
}

/** Migration directories in the order Prisma applies them. */
export function readMigrationNames(migrationsDir) {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** The history up to and including `through`; an empty `through` keeps everything. */
export function selectMigrationsThrough(names, through) {
  if (!through) {
    return [...names];
  }
  const index = names.indexOf(through);
  if (index < 0) {
    throw new MigrationHistoryError(
      `Unknown migration "${through}"; MIGRATE_BASELINE_THROUGH must name a directory under prisma/migrations`,
    );
  }
  return names.slice(0, index + 1);
}

/**
 * Read what the target database already records. A row that finished and was
 * not rolled back counts as applied; a row that never finished blocks every
 * command until an operator repairs it with `prisma migrate resolve`.
 */
export async function inspectMigrationHistory(client) {
  try {
    const tables = await client.query(`
      SELECT
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name <> '${HISTORY_TABLE}'
        ) AS has_tables,
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = '${HISTORY_TABLE}'
        ) AS has_history
    `);
    const row = tables.rows[0] ?? {};
    const hasApplicationTables = Boolean(row.has_tables);
    if (!row.has_history) {
      return { hasApplicationTables, applied: [], unfinished: [] };
    }
    const history = await client.query(
      `SELECT migration_name, finished_at, rolled_back_at FROM "${HISTORY_TABLE}" ORDER BY started_at, migration_name`,
    );
    const applied = [];
    const unfinished = [];
    for (const record of history.rows) {
      if (record.rolled_back_at) {
        continue;
      }
      (record.finished_at ? applied : unfinished).push(record.migration_name);
    }
    return { hasApplicationTables, applied, unfinished };
  } catch {
    // Deliberately omit the database client error: pg errors can contain the
    // connection string, host, credentials, or SQL details.
    throw new MigrationHistoryError(
      "Unable to read the migration history of MIGRATE_DATABASE_URL; refusing to continue",
    );
  }
}

/** Decide which migrations a baseline still has to record. */
export function planBaseline({ names, history, through }) {
  const selected = selectMigrationsThrough(names, through);
  if (!history.hasApplicationTables) {
    throw new MigrationHistoryError(
      "MIGRATE_DATABASE_URL has no application tables; baseline is for a database that already carries the schema. Use migrate:fresh-cockroach for an empty database",
    );
  }
  if (history.unfinished.length > 0) {
    throw new MigrationHistoryError(
      `MIGRATE_DATABASE_URL records unfinished migrations (${history.unfinished.join(", ")}); repair them with prisma migrate resolve before baselining`,
    );
  }
  const known = new Set(names);
  const unknown = history.applied.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new MigrationHistoryError(
      `MIGRATE_DATABASE_URL records migrations that do not exist locally (${unknown.join(", ")}); its history belongs to a different migration directory`,
    );
  }
  const selectedSet = new Set(selected);
  const beyond = history.applied.filter((name) => !selectedSet.has(name));
  if (beyond.length > 0) {
    throw new MigrationHistoryError(
      `MIGRATE_DATABASE_URL already records migrations after ${through} (${beyond.join(", ")}); unset MIGRATE_BASELINE_THROUGH or choose a later migration`,
    );
  }
  const appliedSet = new Set(history.applied);
  return {
    selected,
    alreadyRecorded: selected.filter((name) => appliedSet.has(name)),
    pending: selected.filter((name) => !appliedSet.has(name)),
  };
}

/**
 * Prisma resets the shadow database before replaying the history. The replayed
 * migrations relock their tables, and Cockroach refuses to drop a locked table
 * during that reset, so every replay has to start by unlocking the leftovers.
 */
export async function unlockPublicTables(client) {
  try {
    const { rows } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    for (const { table_name: name } of rows) {
      const identifier = String(name).replaceAll('"', '""');
      await client.query(
        `ALTER TABLE "${identifier}" SET (schema_locked = false)`,
      );
    }
    return rows.length;
  } catch {
    throw new MigrationHistoryError(
      "Unable to prepare MIGRATE_SHADOW_DATABASE_URL for a replay; refusing to continue",
    );
  }
}

function databaseKey(connectionString, label) {
  const url = new URL(connectionString);
  if (!url.port) {
    // pg fills an omitted port from PGPORT or 5432, so two spellings of one
    // database could look different here; only explicit ports compare safely.
    throw new MigrationHistoryError(
      `${label} must name its port explicitly (for example :26257); an omitted port cannot be compared against the other database URLs`,
    );
  }
  // pg decodes the database name, so "/%64efaultdb" and "/defaultdb" are one
  // database; compare what pg would connect to, not the raw spelling.
  return `${url.hostname.toLowerCase()}:${url.port}${decodeURIComponent(url.pathname)}`;
}

/** The shadow database is wiped on every replay; it must be nobody's real database. */
export function assertDistinctDatabase(shadowUrl, others) {
  const shadowKey = databaseKey(shadowUrl, "MIGRATE_SHADOW_DATABASE_URL");
  for (const [label, url] of others) {
    if (url && databaseKey(url, label) === shadowKey) {
      throw new MigrationHistoryError(
        `MIGRATE_SHADOW_DATABASE_URL points at the same database as ${label}; the shadow database is reset on every run and must be a dedicated, disposable database`,
      );
    }
  }
}

/** Strip anything that looks like a connection string before it reaches a log. */
export function redactConnectionStrings(text) {
  return String(text).replace(
    /postgres(?:ql)?:\/\/[^\s"'`]+/gi,
    "postgresql://<redacted>",
  );
}

/**
 * Stable identity of a drift script, so an operator can accept exactly the
 * drift that was reviewed and nothing else. Comments and blank lines do not
 * change the identity; any statement does.
 */
export function driftFingerprint(sql) {
  const normalized = String(sql)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("--"))
    .join("\n");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Migration credentials travel only over verified TLS. A cluster on the
 * loopback interface may stay plain; every other host must verify the
 * server certificate and its hostname.
 */
export function assertVerifiedTls(connectionString, label) {
  const url = new URL(connectionString);
  if (LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return;
  }
  // pg honours the last of several sslmode values while URLSearchParams.get()
  // returns the first, so a repeated parameter could pass here and connect
  // in plaintext; only a single, unambiguous setting is accepted. The ssl
  // parameter is refused outright because its precedence has changed across
  // pg releases.
  if (url.searchParams.has("ssl")) {
    throw new MigrationHistoryError(
      `${label} must not carry an ssl parameter; sslmode=verify-full is the only TLS setting the migration commands accept`,
    );
  }
  const modes = url.searchParams.getAll("sslmode");
  if (modes.length !== 1 || modes[0] !== "verify-full") {
    const found = modes.length === 0 ? "no sslmode" : modes.length > 1 ? `sslmode given ${modes.length} times` : `sslmode=${modes[0]}`;
    throw new MigrationHistoryError(
      `${label} must use exactly one sslmode=verify-full (found ${found}); the migration commands refuse unverified or plaintext connections to a remote database`,
    );
  }
}

/** Refuse to deploy where the history is absent, broken, or from another repository. */
export function planDeploy({ names, history }) {
  if (history.applied.length === 0) {
    throw new MigrationHistoryError(
      "MIGRATE_DATABASE_URL records no applied migrations; run migrate:baseline (existing schema) or migrate:fresh-cockroach (empty database) first",
    );
  }
  if (!history.hasApplicationTables) {
    throw new MigrationHistoryError(
      "MIGRATE_DATABASE_URL records applied migrations but has no application tables; the schema was dropped or the history belongs to another database. Refusing to deploy",
    );
  }
  if (history.unfinished.length > 0) {
    throw new MigrationHistoryError(
      `MIGRATE_DATABASE_URL records unfinished migrations (${history.unfinished.join(", ")}); repair them with prisma migrate resolve before deploying`,
    );
  }
  const known = new Set(names);
  const unknown = history.applied.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    const applied = new Set(history.applied);
    const everyLocalRecorded = names.every((name) => applied.has(name));
    throw new MigrationHistoryError(
      everyLocalRecorded
        ? `MIGRATE_DATABASE_URL is ahead of this checkout: it records ${unknown.join(", ")}, which prisma/migrations does not contain. Update the checkout, or skip migrate:deploy when rolling back an older release`
        : `MIGRATE_DATABASE_URL records migrations that do not exist locally (${unknown.join(", ")}); its history belongs to a different migration directory. Refusing to deploy`,
    );
  }
  const applied = new Set(history.applied);
  // The chain is forward-only: a recorded migration after an unrecorded one
  // would make deploy run the older one last, after the migrations that may
  // supersede it. The recorded names must be an exact prefix of the history.
  const gap = names.slice(0, history.applied.length).find((name) => !applied.has(name));
  if (gap) {
    const later = history.applied[history.applied.length - 1];
    throw new MigrationHistoryError(
      `MIGRATE_DATABASE_URL records ${later} but not the earlier ${gap}; a gap in the history cannot be deployed over. Repair the record with prisma migrate resolve first`,
    );
  }
  return { pending: names.filter((name) => !applied.has(name)) };
}

const DATA_STATEMENT = /^\s*(INSERT|UPDATE|DELETE|UPSERT|MERGE)\b/i;

/**
 * Migrations that change rows, not only the schema. A schema comparison
 * cannot tell whether their effects reached a database, so a baseline has to
 * be told that an operator checked them.
 */
export function findDataMigrations(migrationsDir, names) {
  return names.filter((name) => {
    const sql = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8");
    return sql
      .split("\n")
      .some((line) => !line.trimStart().startsWith("--") && DATA_STATEMENT.test(line));
  });
}
