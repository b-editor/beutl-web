import { describe, expect, it } from "vitest";
import {
  SCHEMA_LOCK_OPTION,
  withFreshCockroachMigrationOption,
} from "../../apps/web/scripts/cockroach-migration-url.mjs";

describe("fresh Cockroach migration URL", () => {
  it("preserves existing query parameters and appends the bootstrap option", () => {
    const result = withFreshCockroachMigrationOption(
      "postgresql://root@127.0.0.1:26267/fresh?sslmode=disable&options=-c%20statement_timeout%3D120000",
    );
    const parsed = new URL(result);
    expect(parsed.searchParams.get("sslmode")).toBe("disable");
    expect(parsed.searchParams.get("options")).toBe(
      `-c statement_timeout=120000 ${SCHEMA_LOCK_OPTION}`,
    );
  });

  it("does not mutate the runtime URL", () => {
    const runtime =
      "postgresql://root@127.0.0.1:26267/runtime?sslmode=disable";
    expect(withFreshCockroachMigrationOption(runtime)).not.toBe(runtime);
    expect(runtime).not.toContain("create_table_with_schema_locked");
  });

  it("uses the Cockroach v26.3 session variable, not the experimental name", () => {
    expect(SCHEMA_LOCK_OPTION).toBe(
      "-c create_table_with_schema_locked=off",
    );
    expect(SCHEMA_LOCK_OPTION).not.toContain("schema_locked_default");
  });
});
