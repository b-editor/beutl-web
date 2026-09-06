const SCHEMA_LOCK_OPTION = "-c create_table_with_schema_locked=off";

/**
 * Add the Cockroach fresh-chain bootstrap session option without changing the
 * caller's runtime URL. Existing query parameters (including options) remain
 * intact; the appended setting wins if an older option set it differently.
 */
export function withFreshCockroachMigrationOption(connectionString) {
  const url = new URL(connectionString);
  const existing = url.searchParams.get("options")?.trim();
  url.searchParams.set(
    "options",
    [existing, SCHEMA_LOCK_OPTION].filter(Boolean).join(" "),
  );
  return url.toString();
}

export { SCHEMA_LOCK_OPTION };
