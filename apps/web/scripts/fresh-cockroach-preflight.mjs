const FRESH_SCHEMA_ERROR =
  "FRESH_COCKROACH_DATABASE_URL must target an empty public schema";
const APPLIED_MIGRATIONS_ERROR =
  "FRESH_COCKROACH_DATABASE_URL must target a database with no applied migrations";
const PREFLIGHT_ERROR =
  "Unable to verify FRESH_COCKROACH_DATABASE_URL; refusing to run migrations";

class PreflightValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PreflightValidationError";
  }
}

/** Verify the bootstrap database without logging or mutating its URL/database. */
export async function assertFreshCockroachDatabase(client) {
  try {
    // Prisma can collide with more than tables and views. Keep this read-only
    // check in one query so a newly supported object kind cannot be skipped by
    // an early return from a partial catalog check.
    const objects = await client.query(`
      SELECT object_kind, object_name
      FROM (
        SELECT 'table_or_view' AS object_kind, table_name AS object_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name <> '_prisma_migrations'
        UNION ALL
        SELECT 'sequence' AS object_kind, sequence_name AS object_name
        FROM information_schema.sequences
        WHERE sequence_schema = 'public'
        UNION ALL
        SELECT 'routine' AS object_kind, routine_name AS object_name
        FROM information_schema.routines
        WHERE routine_schema = 'public'
        UNION ALL
        SELECT 'materialized_view' AS object_kind, c.relname AS object_name
        FROM pg_catalog.pg_class AS c
        INNER JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'm'
        UNION ALL
        SELECT 'user_defined_type' AS object_kind, t.typname AS object_name
        FROM pg_catalog.pg_type AS t
        INNER JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
          AND t.typtype IN ('c', 'd', 'e', 'm', 'r')
          AND NOT (
            t.typtype = 'c'
            AND EXISTS (
              SELECT 1
              FROM pg_catalog.pg_class AS migration_table
              WHERE migration_table.oid = t.typrelid
                AND migration_table.relnamespace = n.oid
                AND migration_table.relname = '_prisma_migrations'
                AND migration_table.relkind IN ('r', 'p')
            )
          )
      ) AS public_objects
      LIMIT 1
    `);
    if (objects.rows.length > 0) {
      throw new PreflightValidationError(FRESH_SCHEMA_ERROR);
    }

    const migrationTable = await client.query(`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = '_prisma_migrations') AS exists
    `);
    if (migrationTable.rows[0]?.exists) {
      const migrations = await client.query(
        'SELECT count(*)::INT AS count FROM "_prisma_migrations"',
      );
      if (Number(migrations.rows[0]?.count ?? 0) > 0) {
        throw new PreflightValidationError(APPLIED_MIGRATIONS_ERROR);
      }
    }
  } catch (error) {
    if (error instanceof PreflightValidationError) {
      throw error;
    }
    // Deliberately omit the database client error and cause: pg errors can
    // contain the connection string, host, credentials, or SQL details.
    throw new Error(PREFLIGHT_ERROR);
  }
}
