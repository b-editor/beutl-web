import { describe, expect, it } from "vitest";
import { assertFreshCockroachDatabase } from "../../apps/web/scripts/fresh-cockroach-preflight.mjs";

function clientFor(...responses: Array<{ rows: unknown[] }>) {
  let index = 0;
  return { query: async () => responses[index++] ?? { rows: [] } };
}

describe("fresh Cockroach database preflight", () => {
  it("accepts an empty public schema", async () => {
    await expect(
      assertFreshCockroachDatabase(
        clientFor({ rows: [] }, { rows: [{ exists: false }] }),
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["a public user table", { object_kind: "table_or_view", object_name: "User" }],
    ["a public enum", { object_kind: "user_defined_type", object_name: "Role" }],
    ["a public user-defined type", { object_kind: "user_defined_type", object_name: "money_usd" }],
    ["a public multirange type", { object_kind: "user_defined_type", object_name: "money_multirange" }],
    ["a public sequence", { object_kind: "sequence", object_name: "User_id_seq" }],
    ["a public materialized view", { object_kind: "materialized_view", object_name: "active_users" }],
    ["a public routine", { object_kind: "routine", object_name: "refresh_users" }],
  ])("rejects %s", async (_description, object) => {
    await expect(
      assertFreshCockroachDatabase(clientFor({ rows: [object] })),
    ).rejects.toThrow("empty public schema");
  });

  it("allows an empty _prisma_migrations table", async () => {
    await expect(
      assertFreshCockroachDatabase(
        clientFor(
          { rows: [] },
          { rows: [{ exists: true }] },
          { rows: [{ count: 0 }] },
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("uses the public catalog census for all migration-colliding object kinds", async () => {
    const queries: string[] = [];
    await expect(
      assertFreshCockroachDatabase({
        query: async (query: string) => {
          queries.push(query);
          return queries.length === 1
            ? { rows: [] }
            : { rows: [{ exists: false }] };
        },
      }),
    ).resolves.toBeUndefined();
    expect(queries[0]).toContain("information_schema.sequences");
    expect(queries[0]).toContain("information_schema.routines");
    expect(queries[0]).toContain("pg_catalog.pg_class");
    expect(queries[0]).toContain("c.relkind = 'm'");
    expect(queries[0]).toContain("pg_catalog.pg_type");
    expect(queries[0]).toContain("t.typtype IN ('c', 'd', 'e', 'm', 'r')");
    expect(queries[0]).toContain("migration_table.relkind IN ('r', 'p')");
  });

  it("rejects applied migration rows", async () => {
    await expect(
      assertFreshCockroachDatabase(
        clientFor(
          { rows: [] },
          { rows: [{ exists: true }] },
          { rows: [{ count: 1 }] },
        ),
      ),
    ).rejects.toThrow("no applied migrations");
  });

  it("hides connection/query details", async () => {
    await expect(
      assertFreshCockroachDatabase({
        query: async () => {
          throw new Error("postgresql://secret@example.invalid/password");
        },
      }),
    ).rejects.toThrow("refusing to run migrations");
    await expect(
      assertFreshCockroachDatabase({
        query: async () => {
          throw new Error(
            "FRESH_COCKROACH_DATABASE_URL must target an empty public schema: secret",
          );
        },
      }),
    ).rejects.toThrow("refusing to run migrations");
  });
});
