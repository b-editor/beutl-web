import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MigrationHistoryError,
  assertDistinctDatabase,
  driftFingerprint,
  inspectMigrationHistory,
  planBaseline,
  readMigrationNames,
  redactConnectionStrings,
  selectMigrationsThrough,
  unlockPublicTables,
} from "../../apps/web/scripts/cockroach-migration-history.mjs";

const names = [
  "20260302104549_init",
  "20260302201320_change_bigint_to_int",
  "20260907010000_add_storage_folders",
];

function clientFor(...responses: Array<{ rows: unknown[] }>) {
  let index = 0;
  return { query: async () => responses[index++] ?? { rows: [] } };
}

function recordingClient(...responses: Array<{ rows: unknown[] }>) {
  const queries: string[] = [];
  let index = 0;
  return {
    queries,
    query: async (query: string) => {
      queries.push(query);
      return responses[index++] ?? { rows: [] };
    },
  };
}

describe("readMigrationNames", () => {
  it("lists migration directories in apply order and ignores files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beutl-history-"));
    try {
      await mkdir(join(dir, names[2]));
      await mkdir(join(dir, names[0]));
      await mkdir(join(dir, names[1]));
      await writeFile(
        join(dir, "migration_lock.toml"),
        'provider = "cockroachdb"\n',
      );
      expect(readMigrationNames(dir)).toEqual(names);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("selectMigrationsThrough", () => {
  it("keeps the whole history without a boundary", () => {
    expect(selectMigrationsThrough(names, undefined)).toEqual(names);
    expect(selectMigrationsThrough(names, "")).toEqual(names);
  });

  it("keeps the history up to and including the boundary", () => {
    expect(selectMigrationsThrough(names, names[1])).toEqual(names.slice(0, 2));
  });

  it("rejects a boundary that is not a migration", () => {
    expect(() => selectMigrationsThrough(names, "20260101000000_missing")).toThrow(
      MigrationHistoryError,
    );
  });
});

describe("inspectMigrationHistory", () => {
  it("reports a hand-migrated schema that has no history table", async () => {
    await expect(
      inspectMigrationHistory(
        clientFor({ rows: [{ has_tables: true, has_history: false }] }),
      ),
    ).resolves.toEqual({
      hasApplicationTables: true,
      applied: [],
      unfinished: [],
    });
  });

  it("separates applied, unfinished, and rolled-back records", async () => {
    await expect(
      inspectMigrationHistory(
        clientFor(
          { rows: [{ has_tables: true, has_history: true }] },
          {
            rows: [
              { migration_name: names[0], finished_at: new Date(), rolled_back_at: null },
              { migration_name: names[1], finished_at: null, rolled_back_at: new Date() },
              { migration_name: names[2], finished_at: null, rolled_back_at: null },
            ],
          },
        ),
      ),
    ).resolves.toEqual({
      hasApplicationTables: true,
      applied: [names[0]],
      unfinished: [names[2]],
    });
  });

  it("hides connection and query details", async () => {
    await expect(
      inspectMigrationHistory({
        query: async () => {
          throw new Error("postgresql://secret@example.invalid/password");
        },
      }),
    ).rejects.toThrow("refusing to continue");
  });
});

describe("planBaseline", () => {
  const empty = { hasApplicationTables: true, applied: [], unfinished: [] };

  it("records every migration on a database that received them by hand", () => {
    expect(planBaseline({ names, history: empty, through: undefined })).toEqual({
      selected: names,
      alreadyRecorded: [],
      pending: names,
    });
  });

  it("keeps migrations that are already recorded", () => {
    expect(
      planBaseline({
        names,
        history: { ...empty, applied: [names[0]] },
        through: undefined,
      }),
    ).toEqual({
      selected: names,
      alreadyRecorded: [names[0]],
      pending: names.slice(1),
    });
  });

  it("stops at the boundary so migrate deploy can apply the rest", () => {
    expect(
      planBaseline({ names, history: empty, through: names[1] }).pending,
    ).toEqual(names.slice(0, 2));
  });

  it("refuses an empty database", () => {
    expect(() =>
      planBaseline({
        names,
        history: { ...empty, hasApplicationTables: false },
        through: undefined,
      }),
    ).toThrow("migrate:fresh-cockroach");
  });

  it("refuses a database with an unfinished migration", () => {
    expect(() =>
      planBaseline({
        names,
        history: { ...empty, unfinished: [names[2]] },
        through: undefined,
      }),
    ).toThrow("unfinished");
  });

  it("refuses a history from another migration directory", () => {
    expect(() =>
      planBaseline({
        names,
        history: { ...empty, applied: ["20250101000000_elsewhere"] },
        through: undefined,
      }),
    ).toThrow("do not exist locally");
  });

  it("refuses a boundary before migrations that are already recorded", () => {
    expect(() =>
      planBaseline({
        names,
        history: { ...empty, applied: [names[2]] },
        through: names[1],
      }),
    ).toThrow("already records migrations after");
  });
});

describe("unlockPublicTables", () => {
  it("unlocks every base table with a quoted identifier", async () => {
    const client = recordingClient({
      rows: [{ table_name: "User" }, { table_name: 'Odd"Name' }],
    });
    await expect(unlockPublicTables(client)).resolves.toBe(2);
    expect(client.queries[0]).toContain("table_type = 'BASE TABLE'");
    expect(client.queries[1]).toBe(
      'ALTER TABLE "User" SET (schema_locked = false)',
    );
    expect(client.queries[2]).toBe(
      'ALTER TABLE "Odd""Name" SET (schema_locked = false)',
    );
  });

  it("hides connection and query details", async () => {
    await expect(
      unlockPublicTables({
        query: async () => {
          throw new Error("postgresql://secret@example.invalid/password");
        },
      }),
    ).rejects.toThrow("refusing to continue");
  });
});

describe("assertDistinctDatabase", () => {
  const target =
    "postgresql://root@cluster.example.invalid:26257/defaultdb?sslmode=verify-full";

  it("rejects the target database even under a different query string", () => {
    expect(() =>
      assertDistinctDatabase(
        "postgresql://root@CLUSTER.example.invalid/defaultdb?options=-c%20x%3D1",
        [["MIGRATE_DATABASE_URL", target]],
      ),
    ).toThrow("same database as MIGRATE_DATABASE_URL");
  });

  it("rejects the developer database", () => {
    expect(() =>
      assertDistinctDatabase(target, [
        ["MIGRATE_DATABASE_URL", "postgresql://root@other.example.invalid/prod"],
        ["DATABASE_URL", target],
      ]),
    ).toThrow("same database as DATABASE_URL");
  });

  it("accepts another database on the same cluster", () => {
    expect(() =>
      assertDistinctDatabase(
        "postgresql://root@cluster.example.invalid:26257/shadow?sslmode=verify-full",
        [
          ["MIGRATE_DATABASE_URL", target],
          ["DATABASE_URL", undefined],
        ],
      ),
    ).not.toThrow();
  });
});

describe("redactConnectionStrings", () => {
  it("removes connection strings from a message", () => {
    expect(
      redactConnectionStrings(
        'failed: postgres://user:pw@host/db?sslmode=verify-full and "postgresql://a@b/c"',
      ),
    ).toBe('failed: postgresql://<redacted> and "postgresql://<redacted>"');
  });
});

describe("driftFingerprint", () => {
  const script = [
    "-- AlterTable",
    'ALTER TABLE "BillingOffer" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();',
    "",
  ].join("\n");

  it("ignores comments and blank lines but not statements", () => {
    const same = `\n-- another comment\n${script}\n\n`;
    expect(driftFingerprint(same)).toBe(driftFingerprint(script));
    expect(driftFingerprint(script)).toMatch(/^[0-9a-f]{16}$/);
    expect(driftFingerprint(script.replace("BillingOffer", "Subscription"))).not.toBe(
      driftFingerprint(script),
    );
  });
});
