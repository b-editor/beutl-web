import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

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

function databaseKey(connectionString) {
  const url = new URL(connectionString);
  return `${url.hostname.toLowerCase()}:${url.port || "26257"}${url.pathname}`;
}

/** The shadow database is wiped on every replay; it must be nobody's real database. */
export function assertDistinctDatabase(shadowUrl, others) {
  const shadowKey = databaseKey(shadowUrl);
  for (const [label, url] of others) {
    if (url && databaseKey(url) === shadowKey) {
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
