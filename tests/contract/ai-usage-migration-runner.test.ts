import { describe, expect, it, vi } from "vitest";
import {
  AI_USAGE_MIGRATIONS,
  pendingAiUsageMigrations,
  runAiUsageMigration,
} from "../../apps/web/scripts/ai-usage-migration.mjs";

const migrations = AI_USAGE_MIGRATIONS.map((name: string) => ({
  name,
  checksum: name,
}));
type MigrationHistory = {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
};
const applied = (name: string): MigrationHistory => ({
  migration_name: name,
  checksum: name,
  finished_at: new Date(),
  rolled_back_at: null,
});

function fixture({
  history = [] as ReturnType<typeof applied>[],
  activeJobs = "0",
  changedLedger = false,
  locked = true,
} = {}) {
  let deployed = false;
  const deploy = vi.fn(async () => {
    deployed = true;
  });
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM "_prisma_migrations"')) return { rows: history };
      if (sql.includes("WHERE status IN"))
        return { rows: [{ count: activeJobs }] };
      if (sql.startsWith("SELECT COUNT(*)")) {
        return {
          rows: [
            {
              rowCount: "1",
              units0: deployed && changedLedger ? "11.000000" : "10.000000",
            },
          ],
        };
      }
      if (sql.startsWith("SHOW CREATE TABLE")) {
        return {
          rows: [
            {
              create_statement: `CREATE TABLE ... WITH (schema_locked = ${locked})`,
            },
          ],
        };
      }
      if (sql.startsWith("ALTER TABLE")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
  return { client, deploy, migrations };
}

describe("AI billing maintenance cutover", () => {
  it("refuses an online cutover before doing any schema writes", async () => {
    const run = fixture();
    await expect(runAiUsageMigration(run)).rejects.toThrow("--writers-stopped");
    expect(run.deploy).not.toHaveBeenCalled();
    expect(
      run.client.query.mock.calls.some(([sql]) => sql.startsWith("ALTER")),
    ).toBe(false);
  });

  it("offers a read-only preflight without requesting maintenance", async () => {
    const run = fixture();
    await expect(
      runAiUsageMigration({ ...run, checkOnly: true }),
    ).resolves.toEqual({
      pending: AI_USAGE_MIGRATIONS,
      needsMaintenance: true,
    });
    expect(run.deploy).not.toHaveBeenCalled();
  });

  it("refuses to migrate while paid jobs still need completion writers", async () => {
    const run = fixture({ activeJobs: "1" });
    await expect(
      runAiUsageMigration({ ...run, writersStopped: true }),
    ).rejects.toThrow("Active AI jobs remain");
    expect(run.deploy).not.toHaveBeenCalled();
  });

  it("accepts a stopped and drained cutover that preserves ledger totals", async () => {
    const run = fixture();
    await expect(
      runAiUsageMigration({ ...run, writersStopped: true }),
    ).resolves.toEqual({
      applied: AI_USAGE_MIGRATIONS,
      needsMaintenance: true,
    });
    expect(run.deploy).toHaveBeenCalledOnce();
  });

  it("applies lock repairs to a database that already completed both billing migrations", async () => {
    const run = fixture({
      history: AI_USAGE_MIGRATIONS.slice(1, 3).map(applied),
    });
    await expect(runAiUsageMigration(run)).resolves.toEqual({
      applied: [AI_USAGE_MIGRATIONS[0], AI_USAGE_MIGRATIONS[3]],
      needsMaintenance: false,
    });
    expect(run.deploy).toHaveBeenCalledOnce();
  });

  it("does not replay a completed migration", async () => {
    const run = fixture({ history: AI_USAGE_MIGRATIONS.map(applied) });
    await expect(runAiUsageMigration(run)).resolves.toEqual({
      pending: [],
      needsMaintenance: false,
    });
    expect(run.deploy).not.toHaveBeenCalled();
  });

  it("rejects a ledger mismatch and restores schema locks", async () => {
    const run = fixture({ changedLedger: true });
    await expect(
      runAiUsageMigration({ ...run, writersStopped: true }),
    ).rejects.toThrow("unit totals changed");
    expect(
      run.client.query.mock.calls.filter(([sql]) =>
        sql.startsWith("ALTER TABLE"),
      ),
    ).toHaveLength(4);
  });

  it("restores every table lock after a partially applied DDL batch fails", async () => {
    const run = fixture();
    run.deploy.mockRejectedValueOnce(new Error("DDL failed"));
    await expect(
      runAiUsageMigration({ ...run, writersStopped: true }),
    ).rejects.toThrow("DDL failed");
    expect(
      run.client.query.mock.calls.filter(([sql]) =>
        sql.startsWith("ALTER TABLE"),
      ),
    ).toHaveLength(4);
  });

  const recoveredHistory = () => [
    applied(AI_USAGE_MIGRATIONS[0]),
    {
      ...applied(AI_USAGE_MIGRATIONS[1]),
      finished_at: null,
      rolled_back_at: new Date(),
    },
  ];

  it("reopens the first billing migration's tables after its unlock was already applied", async () => {
    const run = fixture({ history: recoveredHistory() });
    run.deploy.mockImplementationOnce(async () => {
      expect(run.client.query.mock.calls.filter(([sql]) => sql.includes("schema_locked = false")))
        .toEqual([
          ['ALTER TABLE "AiOperationModel" SET (schema_locked = false)'],
          ['ALTER TABLE "AiJob" SET (schema_locked = false)'],
        ]);
    });

    expect(await runAiUsageMigration({ ...run, writersStopped: true })).toEqual({
      applied: AI_USAGE_MIGRATIONS.slice(1),
      needsMaintenance: true,
    });
    expect(run.deploy).toHaveBeenCalledOnce();
  });

  it.each([
    { checkOnly: true, writersStopped: false, activeJobs: "0", error: null },
    { checkOnly: false, writersStopped: false, activeJobs: "0", error: "--writers-stopped" },
    { checkOnly: false, writersStopped: true, activeJobs: "1", error: "Active AI jobs remain" },
  ])("keeps retry unlocks behind preflight and maintenance gates %#", async ({ error, ...options }) => {
    const run = fixture({ history: recoveredHistory(), activeJobs: options.activeJobs });
    const result = runAiUsageMigration({ ...run, ...options });
    if (error) await expect(result).rejects.toThrow(error);
    else await expect(result).resolves.toMatchObject({ pending: AI_USAGE_MIGRATIONS.slice(1) });
    expect(run.deploy).not.toHaveBeenCalled();
    expect(run.client.query.mock.calls.some(([sql]) => sql.startsWith("ALTER"))).toBe(false);
  });

  it("restores all locks when the retry's second unlock fails", async () => {
    const run = fixture({ history: recoveredHistory() });
    const query = run.client.query.getMockImplementation()!;
    run.client.query.mockImplementation(async (sql) => {
      if (sql === 'ALTER TABLE "AiJob" SET (schema_locked = false)') {
        throw new Error("Retry unlock failed");
      }
      return await query(sql);
    });
    await expect(runAiUsageMigration({ ...run, writersStopped: true }))
      .rejects.toThrow("Retry unlock failed");
    expect(run.deploy).not.toHaveBeenCalled();
    expect(run.client.query.mock.calls.filter(([sql]) => sql.includes("schema_locked = true")))
      .toHaveLength(4);
  });

  it("does not reopen first-migration tables when only the fractional migration is pending", async () => {
    const run = fixture({ history: AI_USAGE_MIGRATIONS.slice(0, 2).map(applied) });
    await runAiUsageMigration({ ...run, writersStopped: true });
    expect(run.client.query.mock.calls.some(([sql]) => sql.includes("schema_locked = false"))).toBe(false);
  });

  it("refuses success if the migration omitted a schema relock", async () => {
    const run = fixture({ locked: false });
    await expect(
      runAiUsageMigration({ ...run, writersStopped: true }),
    ).rejects.toThrow("not schema-locked");
  });

  it("rejects edits to already applied SQL", () => {
    expect(() =>
      pendingAiUsageMigrations(migrations, [
        { ...applied(AI_USAGE_MIGRATIONS[1]), checksum: "different" },
      ]),
    ).toThrow("restore its original SQL");
  });

  it("leaves unrelated historical migration reconciliation outside this cutover", () => {
    expect(
      pendingAiUsageMigrations(migrations, [applied("historical-migration")]),
    ).toEqual(AI_USAGE_MIGRATIONS);
  });

  it("ignores rolled-back attempts but requires recovery of an unresolved failure", () => {
    expect(
      pendingAiUsageMigrations(migrations, [
        {
          ...applied(AI_USAGE_MIGRATIONS[1]),
          checksum: "old failed version",
          finished_at: null,
          rolled_back_at: new Date(),
        },
      ]),
    ).toEqual(AI_USAGE_MIGRATIONS);
    expect(() =>
      pendingAiUsageMigrations(migrations, [
        {
          ...applied(AI_USAGE_MIGRATIONS[1]),
          finished_at: null,
        },
      ]),
    ).toThrow("Recover failed migration");
  });

  it("does not apply unrelated pending migrations under this maintenance acknowledgement", () => {
    expect(() =>
      pendingAiUsageMigrations(
        [...migrations, { name: "other-migration", checksum: "other" }],
        [],
      ),
    ).toThrow("prerequisite migrations separately");
  });
});
