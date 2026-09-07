import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MigrationHistoryError,
  assertConnectionUrl,
  assertDistinctDatabase,
  assertShadowIsNotTarget,
  assertVerifiedTls,
  compareCheckConstraints,
  dataMigrationFingerprint,
  dataStatements,
  driftFingerprint,
  findDataMigrations,
  inspectMigrationHistory,
  localChecksums,
  planBaseline,
  planDeploy,
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
      checksums: {},
    });
  });

  it("separates applied, unfinished, and rolled-back records", async () => {
    await expect(
      inspectMigrationHistory(
        clientFor(
          { rows: [{ has_tables: true, has_history: true }] },
          {
            rows: [
              { migration_name: names[0], checksum: "abc", finished_at: new Date(), rolled_back_at: null },
              { migration_name: names[1], checksum: "def", finished_at: null, rolled_back_at: new Date() },
              { migration_name: names[2], checksum: "ghi", finished_at: null, rolled_back_at: null },
            ],
          },
        ),
      ),
    ).resolves.toEqual({
      hasApplicationTables: true,
      applied: [names[0]],
      unfinished: [names[2]],
      checksums: { [names[0]]: "abc" },
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

  it("refuses a recorded history that is not a prefix, so a gap is never filled out of order", () => {
    expect(() =>
      planBaseline({
        names,
        history: { ...empty, applied: [names[0], names[2]] },
        through: undefined,
      }),
    ).toThrow(`records ${names[2]} where the history expects ${names[1]}`);
  });

  it("refuses a recorded migration whose checksum differs from the local file", () => {
    expect(() =>
      planBaseline({
        names,
        history: { ...empty, applied: [names[0]], checksums: { [names[0]]: "recorded" } },
        through: undefined,
        checksums: { [names[0]]: "local" },
      }),
    ).toThrow("checksum that differs from the local migration.sql");
    expect(
      planBaseline({
        names,
        history: { ...empty, applied: [names[0]], checksums: { [names[0]]: "same" } },
        through: undefined,
        checksums: { [names[0]]: "same" },
      }).pending,
    ).toEqual(names.slice(1));
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
        "postgresql://root@CLUSTER.example.invalid:26257/defaultdb?options=-c%20x%3D1",
        [["MIGRATE_DATABASE_URL", target]],
      ),
    ).toThrow("same database as MIGRATE_DATABASE_URL");
  });

  it("rejects the developer database", () => {
    expect(() =>
      assertDistinctDatabase(target, [
        ["MIGRATE_DATABASE_URL", "postgresql://root@other.example.invalid:26257/prod"],
        ["DATABASE_URL", target],
      ]),
    ).toThrow("same database as DATABASE_URL");
  });

  it("refuses a URL that omits its port instead of guessing one", () => {
    expect(() =>
      assertDistinctDatabase("postgresql://root@cluster.example.invalid/defaultdb", [
        ["MIGRATE_DATABASE_URL", "postgresql://root@cluster.example.invalid:5432/defaultdb"],
      ]),
    ).toThrow("MIGRATE_SHADOW_DATABASE_URL must name its port explicitly");
    expect(() =>
      assertDistinctDatabase(target, [
        ["DATABASE_URL", "postgresql://root@cluster.example.invalid/defaultdb"],
      ]),
    ).toThrow("DATABASE_URL must name its port explicitly");
  });

  it("compares the database name pg would connect to, not its spelling", () => {
    expect(() =>
      assertDistinctDatabase(
        "postgresql://root@cluster.example.invalid:26257/%64efaultdb?sslmode=verify-full",
        [["MIGRATE_DATABASE_URL", target]],
      ),
    ).toThrow("same database as MIGRATE_DATABASE_URL");
  });

  it("treats the loopback aliases as one listener", () => {
    expect(() =>
      assertDistinctDatabase("postgresql://root@127.0.0.1:26257/defaultdb", [
        ["MIGRATE_DATABASE_URL", "postgresql://root@localhost:26257/defaultdb"],
      ]),
    ).toThrow("same database as MIGRATE_DATABASE_URL");
    expect(() =>
      assertDistinctDatabase("postgresql://root@[::1]:26257/defaultdb", [
        ["MIGRATE_DATABASE_URL", "postgresql://root@localhost:26257/defaultdb"],
      ]),
    ).toThrow("same database as MIGRATE_DATABASE_URL");
  });

  it("refuses query parameters that would move the endpoint", () => {
    expect(() =>
      assertDistinctDatabase(
        "postgresql://root@cluster.example.invalid:26257/defaultdb?host=other.example.invalid",
        [["MIGRATE_DATABASE_URL", target]],
      ),
    ).toThrow("MIGRATE_SHADOW_DATABASE_URL must not carry host as query parameters");
  });

  it("ignores a trailing root dot in the hostname", () => {
    expect(() =>
      assertDistinctDatabase(
        "postgresql://root@cluster.example.invalid.:26257/defaultdb?sslmode=verify-full",
        [["MIGRATE_DATABASE_URL", target]],
      ),
    ).toThrow("same database as MIGRATE_DATABASE_URL");
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

describe("assertVerifiedTls", () => {
  it("accepts a remote URL with sslmode=verify-full", () => {
    expect(() =>
      assertVerifiedTls(
        "postgresql://root@cluster.example.invalid:26257/defaultdb?sslmode=verify-full",
        "MIGRATE_DATABASE_URL",
      ),
    ).not.toThrow();
  });

  it.each([
    ["no sslmode", "postgresql://root@cluster.example.invalid:26257/defaultdb"],
    ["sslmode=require", "postgresql://root@cluster.example.invalid:26257/defaultdb?sslmode=require"],
    ["sslmode=disable", "postgresql://root@cluster.example.invalid:26257/defaultdb?sslmode=disable"],
  ])("rejects a remote URL with %s", (_label, url) => {
    expect(() => assertVerifiedTls(url, "MIGRATE_SHADOW_DATABASE_URL")).toThrow(
      "MIGRATE_SHADOW_DATABASE_URL must use exactly one sslmode=verify-full",
    );
  });

  it("rejects a repeated sslmode, which pg resolves to the last value", () => {
    expect(() =>
      assertVerifiedTls(
        "postgresql://root@cluster.example.invalid:26257/defaultdb?sslmode=verify-full&sslmode=disable",
        "MIGRATE_DATABASE_URL",
      ),
    ).toThrow("sslmode given 2 times");
  });

  it("rejects an ssl parameter next to sslmode", () => {
    expect(() =>
      assertVerifiedTls(
        "postgresql://root@cluster.example.invalid:26257/defaultdb?sslmode=verify-full&ssl=0",
        "MIGRATE_DATABASE_URL",
      ),
    ).toThrow("must not carry an ssl parameter");
  });

  it("refuses an endpoint override before granting the loopback exemption", () => {
    expect(() =>
      assertVerifiedTls(
        "postgresql://root@localhost:26257/defaultdb?host=remote.example.invalid&sslmode=disable",
        "MIGRATE_DATABASE_URL",
      ),
    ).toThrow("must not carry host as query parameters");
    expect(() =>
      assertVerifiedTls(
        "postgresql://root@cluster.example.invalid:26257/defaultdb?sslmode=verify-full&port=5432&user=admin",
        "MIGRATE_DATABASE_URL",
      ),
    ).toThrow("must not carry port, user as query parameters");
  });

  it("lets a loopback cluster stay plain", () => {
    expect(() =>
      assertVerifiedTls("postgresql://root@localhost:26257/defaultdb?sslmode=disable", "MIGRATE_DATABASE_URL"),
    ).not.toThrow();
    expect(() =>
      assertVerifiedTls("postgresql://root@127.0.0.1:26257/defaultdb", "MIGRATE_DATABASE_URL"),
    ).not.toThrow();
  });
});

describe("planDeploy", () => {
  const healthy = { hasApplicationTables: true, applied: names.slice(0, 2), unfinished: [] };

  it("lists the migrations that deploy will apply", () => {
    expect(planDeploy({ names, history: healthy })).toEqual({ pending: [names[2]] });
  });

  it("refuses a database without a recorded history", () => {
    expect(() =>
      planDeploy({ names, history: { ...healthy, applied: [] } }),
    ).toThrow("migrate:baseline");
  });

  it("refuses a history whose application tables are gone", () => {
    expect(() =>
      planDeploy({ names, history: { ...healthy, hasApplicationTables: false } }),
    ).toThrow("no application tables");
  });

  it("refuses a database with an unfinished migration", () => {
    expect(() =>
      planDeploy({ names, history: { ...healthy, unfinished: [names[2]] } }),
    ).toThrow("unfinished");
  });

  it("refuses a history from another migration directory", () => {
    expect(() =>
      planDeploy({
        names,
        history: { ...healthy, applied: ["20250101000000_elsewhere"] },
      }),
    ).toThrow("do not exist locally");
  });

  it("refuses a gap in the recorded history", () => {
    expect(() =>
      planDeploy({
        names,
        history: { ...healthy, applied: [names[0], names[2]] },
      }),
    ).toThrow(`records ${names[2]} where the history expects ${names[1]}`);
  });

  it("refuses a recorded history in the wrong order", () => {
    expect(() =>
      planDeploy({
        names,
        history: { ...healthy, applied: [names[1], names[0]] },
      }),
    ).toThrow(`records ${names[1]} where the history expects ${names[0]}`);
  });

  it("refuses a recorded migration whose checksum differs from the local file", () => {
    expect(() =>
      planDeploy({
        names,
        history: { ...healthy, checksums: { [names[0]]: "recorded" } },
        checksums: { [names[0]]: "local", [names[1]]: "x" },
      }),
    ).toThrow("checksum that differs from the local migration.sql");
  });

  it("tells an older checkout apart from a foreign database", () => {
    expect(() =>
      planDeploy({
        names,
        history: { ...healthy, applied: [...names, "20260908000000_newer"] },
      }),
    ).toThrow("ahead of this checkout");
  });
});

describe("findDataMigrations", () => {
  it("keeps only migrations with a row-changing statement outside comments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beutl-data-"));
    try {
      const write = async (name: string, sql: string) => {
        await mkdir(join(dir, name));
        await writeFile(join(dir, name, "migration.sql"), sql);
      };
      await write(names[0], `CREATE TABLE "User" ("id" STRING NOT NULL);\n-- UPDATE "User" SET x = 1;\n`);
      await write(names[1], `ALTER TABLE "User" ADD COLUMN "tags" STRING[];\nUPDATE "User" SET "tags" = {} WHERE "tags" IS NULL;\n`);
      await write(names[2], `INSERT INTO "AiOperationModel" ("operation") VALUES (x)\nON CONFLICT DO NOTHING;\n`);
      expect(findDataMigrations(dir, names)).toEqual([names[1], names[2]]);
      const before = dataMigrationFingerprint(dir, [names[1], names[2]]);
      await writeFile(join(dir, names[2], "migration.sql"), `INSERT INTO "AiOperationModel" ("operation") VALUES (y);\n`);
      expect(dataMigrationFingerprint(dir, [names[1], names[2]])).not.toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("dataStatements", () => {
  it("sees a statement that shares a line with another or follows a block comment", () => {
    expect(
      dataStatements(`CREATE TABLE "T" ("id" STRING); UPDATE "T" SET "id" = 1;`),
    ).toHaveLength(1);
    expect(dataStatements(`/* backfill */ UPDATE "T" SET "id" = 1;`)).toHaveLength(1);
    expect(dataStatements(`WITH d AS (SELECT 1) DELETE FROM "T" WHERE "id" IN (SELECT * FROM d);`)).toHaveLength(1);
    expect(dataStatements(`TRUNCATE "T";`)).toHaveLength(1);
  });

  it("keeps a DO block and a string literal with a semicolon as one statement", () => {
    const block = `DO $$ BEGIN IF EXISTS (SELECT 1 FROM "T") THEN RAISE EXCEPTION 'repair; then retry'; END IF; END $$;`;
    expect(dataStatements(block)).toEqual([block.slice(0, -1)]);
    expect(dataStatements(`ALTER TABLE "T" ALTER COLUMN "note" SET DEFAULT 'a;b';`)).toEqual([]);
  });

  it("reports an ALTER that fills or rewrites existing rows", () => {
    expect(dataStatements(`ALTER TABLE "T" ADD COLUMN "state" STRING NOT NULL DEFAULT 'active';`)).toHaveLength(1);
    expect(dataStatements(`ALTER TABLE "T" ADD COLUMN IF NOT EXISTS "n" INT8 DEFAULT 0;`)).toHaveLength(1);
    expect(dataStatements(`ALTER TABLE "T" ADD COLUMN "total" INT8 AS ("a" + "b") STORED;`)).toHaveLength(1);
    expect(dataStatements(`ALTER TABLE "T" ALTER COLUMN "n" TYPE STRING USING "n"::STRING;`)).toHaveLength(1);
    expect(
      dataStatements(`ALTER TABLE "T" ADD COLUMN "note" STRING;\nALTER TABLE "T" ALTER COLUMN "n" SET DEFAULT 0;\nALTER TABLE "T" ADD CONSTRAINT "c" CHECK ("n" >= 0);\nALTER TABLE "T" SET (schema_locked = true);`),
    ).toEqual([]);
  });

  it("reports every construct that is not purely structural", () => {
    expect(dataStatements(`COPY "T" FROM STDIN;`)).toHaveLength(1);
    expect(dataStatements(`IMPORT INTO "T" CSV DATA (x);`)).toHaveLength(1);
    expect(dataStatements(`CREATE TABLE "Copy" AS SELECT * FROM "T";`)).toHaveLength(1);
    expect(dataStatements(`SELECT crdb_internal.something();`)).toHaveLength(1);
    expect(
      dataStatements(`CREATE TABLE "T" ("id" STRING NOT NULL, CONSTRAINT "T_pkey" PRIMARY KEY ("id"));\nCREATE UNIQUE INDEX "T_id_key" ON "T"("id");\nCREATE VIEW "V" AS SELECT "id" FROM "T";\nSET create_table_with_schema_locked = off;`),
    ).toEqual([]);
  });

  it("ignores comments and schema-only statements", () => {
    expect(
      dataStatements(`-- UPDATE "T" SET x = 1;\n/* DELETE FROM "T"; */\nALTER TABLE "T" ADD CONSTRAINT "fk" FOREIGN KEY ("p") REFERENCES "P"("id") ON DELETE CASCADE ON UPDATE CASCADE;`),
    ).toEqual([]);
  });
});

describe("assertShadowIsNotTarget", () => {
  it("passes when the target cannot see the probe, and drops the probe", async () => {
    const shadow = recordingClient({ rows: [] }, { rows: [] }, { rows: [] }, { rows: [{ visible: true }] }, { rows: [] });
    const target = recordingClient({ rows: [] }, { rows: [{ visible: false }] });
    await expect(
      assertShadowIsNotTarget({ shadowClient: shadow, targetClient: target }),
    ).resolves.toBeUndefined();
    expect(shadow.queries[0]).toBe("SET default_transaction_use_follower_reads = off");
    expect(target.queries[0]).toBe("SET default_transaction_use_follower_reads = off");
    expect(shadow.queries[1]).toMatch(
      /^CREATE TABLE "_beutl_shadow_probe_[0-9a-f]{32}" \("id" INT8 PRIMARY KEY\) WITH \(schema_locked = false\)$/,
    );
    expect(shadow.queries[2]).toMatch(/^GRANT SELECT ON TABLE "_beutl_shadow_probe_[0-9a-f]{32}" TO public$/);
    expect(shadow.queries[3]).toContain("information_schema.tables");
    expect(shadow.queries[4]).toMatch(/^DROP TABLE IF EXISTS "_beutl_shadow_probe_[0-9a-f]{32}"/);
    expect(target.queries[1]).toContain("information_schema.tables");
  });

  it("refuses when the target sees the probe, and still drops it", async () => {
    const shadow = recordingClient({ rows: [] }, { rows: [] }, { rows: [] }, { rows: [{ visible: true }] }, { rows: [] });
    const target = recordingClient({ rows: [] }, { rows: [{ visible: true }] });
    await expect(
      assertShadowIsNotTarget({ shadowClient: shadow, targetClient: target }),
    ).rejects.toThrow("reaches the same database as MIGRATE_DATABASE_URL");
    expect(shadow.queries).toHaveLength(5);
    expect(shadow.queries[4]).toMatch(/^DROP TABLE IF EXISTS/);
  });

  it("refuses when the shadow cannot see its own probe, so an unreliable catalog never passes", async () => {
    const shadow = recordingClient({ rows: [] }, { rows: [] }, { rows: [] }, { rows: [{ visible: false }] }, { rows: [] });
    const target = recordingClient({ rows: [] }, { rows: [{ visible: false }] });
    await expect(
      assertShadowIsNotTarget({ shadowClient: shadow, targetClient: target }),
    ).rejects.toThrow("cannot see its own probe");
    expect(target.queries).toHaveLength(1);
    expect(shadow.queries[4]).toMatch(/^DROP TABLE IF EXISTS/);
  });

  it("hides connection and query details", async () => {
    const shadow = recordingClient({ rows: [] }, { rows: [] }, { rows: [] }, { rows: [{ visible: true }] }, { rows: [] });
    await expect(
      assertShadowIsNotTarget({
        shadowClient: shadow,
        targetClient: {
          query: async () => {
            throw new Error("postgresql://secret@example.invalid/password");
          },
        },
      }),
    ).rejects.toThrow("refusing to continue");
    expect(shadow.queries.at(-1)).toMatch(/^DROP TABLE IF EXISTS/);
  });
});

describe("localChecksums", () => {
  it("matches what Prisma records: the sha256 of migration.sql", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beutl-checksum-"));
    try {
      await mkdir(join(dir, names[0]));
      await writeFile(join(dir, names[0], "migration.sql"), "CREATE TABLE \"T\" (\"id\" STRING);\n");
      expect(localChecksums(dir, [names[0]])).toEqual({
        [names[0]]: createHash("sha256")
          .update(`CREATE TABLE "T" ("id" STRING);\n`)
          .digest("hex"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("assertConnectionUrl", () => {
  const good = "postgresql://root@cluster.example.invalid:26257/defaultdb?sslmode=verify-full";

  it("accepts a complete remote URL and the public schema", () => {
    expect(() => assertConnectionUrl(good, "MIGRATE_DATABASE_URL")).not.toThrow();
    expect(() => assertConnectionUrl(`${good}&schema=public`, "MIGRATE_DATABASE_URL")).not.toThrow();
  });

  it("requires an explicit port on every command, not only the shadow check", () => {
    expect(() =>
      assertConnectionUrl("postgresql://root@cluster.example.invalid/defaultdb?sslmode=verify-full", "MIGRATE_DATABASE_URL"),
    ).toThrow("MIGRATE_DATABASE_URL must name its port explicitly");
  });

  it("refuses a schema Prisma would honour but pg would not", () => {
    expect(() => assertConnectionUrl(`${good}&schema=other`, "MIGRATE_DATABASE_URL")).toThrow(
      "must not select a schema other than public",
    );
    expect(() =>
      assertConnectionUrl(`${good}&options=-c%20search_path%3Dother`, "MIGRATE_DATABASE_URL"),
    ).toThrow("must not set search_path");
  });

  it("still applies the endpoint and TLS rules", () => {
    expect(() => assertConnectionUrl(`${good}&host=x`, "MIGRATE_DATABASE_URL")).toThrow("must not carry host");
    expect(() =>
      assertConnectionUrl("postgresql://root@cluster.example.invalid:26257/defaultdb", "MIGRATE_DATABASE_URL"),
    ).toThrow("exactly one sslmode=verify-full");
  });
});

describe("compareCheckConstraints", () => {
  const row = (table_name: string, name: string, definition: string) => ({ table_name, name, definition });

  it("returns nothing when the target carries the history's constraints", async () => {
    const rows = [row("T", "T_n_check", "CHECK ((n >= 0))")];
    await expect(
      compareCheckConstraints({ targetClient: clientFor({ rows }), shadowClient: clientFor({ rows }) }),
    ).resolves.toEqual([]);
  });

  it("emits SQL for missing, changed, and extra constraints", async () => {
    const shadow = clientFor({ rows: [row("T", "T_k_check", "CHECK ((k IN ('a')))"), row("T", "T_n_check", "CHECK ((n >= 0))")] });
    const target = clientFor({ rows: [row("T", "T_k_check", "CHECK ((k IN ('a', 'b')))"), row("U", "U_old_check", "CHECK ((x > 0))")] });
    await expect(compareCheckConstraints({ targetClient: target, shadowClient: shadow })).resolves.toEqual([
      `ALTER TABLE "T" DROP CONSTRAINT "T_k_check";`,
      `ALTER TABLE "T" ADD CONSTRAINT "T_k_check" CHECK ((k IN ('a')));`,
      `ALTER TABLE "T" ADD CONSTRAINT "T_n_check" CHECK ((n >= 0));`,
      `ALTER TABLE "U" DROP CONSTRAINT "U_old_check";`,
    ]);
  });

  it("hides connection and query details", async () => {
    await expect(
      compareCheckConstraints({
        targetClient: { query: async () => { throw new Error("postgresql://secret@example.invalid/p"); } },
        shadowClient: clientFor({ rows: [] }),
      }),
    ).rejects.toThrow("refusing to continue");
  });
});
