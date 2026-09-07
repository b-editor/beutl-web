import { createHash, randomUUID } from "node:crypto";
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
  // database; compare what pg would connect to, not the raw spelling. The
  // loopback aliases are one listener as well. Anything a name can still
  // hide (a CNAME, a proxy) is caught by connectedDatabaseIdentity().
  const hostname = url.hostname.toLowerCase();
  const host = LOOPBACK_HOSTS.has(hostname) ? "loopback" : hostname;
  return `${host}:${url.port}${decodeURIComponent(url.pathname)}`;
}

/**
 * Prove that the two connections do not reach one database, whatever the
 * URLs look like: an empty probe table created through the shadow connection
 * must be invisible through the target connection. CockroachDB Cloud does not
 * expose crdb_internal.cluster_id(), so the proof has to be observational;
 * the probe is dropped again either way, and the shadow is reset afterwards.
 */
export async function assertShadowIsNotTarget({ shadowClient, targetClient }) {
  const probe = `_beutl_shadow_probe_${randomUUID().replaceAll("-", "")}`;
  try {
    await shadowClient.query(`CREATE TABLE "${probe}" ("id" INT8 PRIMARY KEY)`);
    const { rows } = await targetClient.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1) AS visible",
      [probe],
    );
    if (rows[0]?.visible) {
      throw new MigrationHistoryError(
        "MIGRATE_SHADOW_DATABASE_URL reaches the same database as MIGRATE_DATABASE_URL: a table created through the shadow URL is visible through the target URL. The shadow database is reset on every run and must be a dedicated, disposable database",
      );
    }
  } catch (error) {
    if (error instanceof MigrationHistoryError) {
      throw error;
    }
    throw new MigrationHistoryError(
      "Unable to prove that MIGRATE_SHADOW_DATABASE_URL and MIGRATE_DATABASE_URL are different databases; refusing to continue",
    );
  } finally {
    await shadowClient
      .query(`DROP TABLE IF EXISTS "${probe}"`)
      .catch(() => undefined);
  }
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
  // The chain is forward-only: a recorded migration after an unrecorded one,
  // or two recorded out of order, would make deploy run an older migration
  // after the ones that may supersede it. The recorded names, in the order
  // they were recorded, must be an exact prefix of the history.
  for (let index = 0; index < history.applied.length; index++) {
    if (history.applied[index] !== names[index]) {
      throw new MigrationHistoryError(
        `MIGRATE_DATABASE_URL records ${history.applied[index]} where the history expects ${names[index]}; the recorded chain must match prisma/migrations in order and without gaps. Repair the record with prisma migrate resolve first`,
      );
    }
  }
  return { pending: names.slice(history.applied.length) };
}

const DATA_STATEMENT = /^(INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE)\b/i;
const DATA_KEYWORD = /\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE)\b/i;

/**
 * Statements in a migration that change rows. Comments are removed first and
 * the text is split on ";" so a statement that shares a line with another, or
 * follows a block comment, is still seen. A CTE counts when it carries a
 * data keyword anywhere, because "WITH ... UPDATE" is how backfills are
 * usually written. The detector errs toward reporting a statement.
 */
export function dataStatements(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .split(";")
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        DATA_STATEMENT.test(statement) ||
        (/^WITH\b/i.test(statement) && DATA_KEYWORD.test(statement)),
    );
}

function readMigrationSql(migrationsDir, name) {
  return readFileSync(join(migrationsDir, name, "migration.sql"), "utf8");
}

/**
 * Migrations that change rows, not only the schema. A schema comparison
 * cannot tell whether their effects reached a database, so a baseline has to
 * be told that an operator checked them.
 */
export function findDataMigrations(migrationsDir, names) {
  return names.filter(
    (name) => dataStatements(readMigrationSql(migrationsDir, name)).length > 0,
  );
}

/**
 * Identity of the data migrations an operator verified: the names and the
 * SQL, so an edited migration.sql invalidates the confirmation.
 */
export function dataMigrationFingerprint(migrationsDir, names) {
  return driftFingerprint(
    names
      .map((name) => `${name}\n${readMigrationSql(migrationsDir, name)}`)
      .join("\n"),
  );
}
