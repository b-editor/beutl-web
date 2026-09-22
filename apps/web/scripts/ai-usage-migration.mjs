// The original billing migrations are immutable. This runner supplies the
// maintenance boundary required by their add/backfill/swap sequence.
export const AI_USAGE_MIGRATIONS = [
  "20260921005000_unlock_ai_cost_billing_tables",
  "20260921010000_add_actual_ai_cost_billing",
  "20260921020000_fractional_ai_usage_units",
  "20260921030000_relock_ai_cost_billing_tables",
];
const BILLING_MIGRATIONS = new Set(AI_USAGE_MIGRATIONS.slice(1, 3));
const [UNLOCK_MIGRATION, ACTUAL_COST_MIGRATION] = AI_USAGE_MIGRATIONS;
const BILLING_TABLES = [
  "AiOperationModel",
  "AiJob",
  "CreditAccount",
  "CreditTransaction",
];

export function pendingAiUsageMigrations(migrations, history) {
  const applied = new Set();
  for (const row of history) {
    if (row.rolled_back_at !== null) continue;
    if (row.finished_at === null) {
      throw new Error(
        `Recover failed migration ${row.migration_name} before the AI billing cutover`,
      );
    }
    if (AI_USAGE_MIGRATIONS.includes(row.migration_name)) {
      const local = migrations.find(
        (migration) => migration.name === row.migration_name,
      );
      if (!local || local.checksum !== row.checksum) {
        throw new Error(
          `Applied migration ${row.migration_name} is missing or modified; restore its original SQL`,
        );
      }
    }
    applied.add(row.migration_name);
  }
  const pending = migrations.filter(
    (migration) => !applied.has(migration.name),
  );
  if (
    pending.some((migration) => !AI_USAGE_MIGRATIONS.includes(migration.name))
  ) {
    throw new Error(
      "Apply prerequisite migrations separately; this command only accepts the AI billing cutover migrations",
    );
  }
  return pending.map((migration) => migration.name);
}

// Compare existing row counts and unit totals before/after the type change.
// New reservation columns start as NULL and are not part of this baseline.
async function readLedgerTotals(client) {
  const totals = {};
  for (const [table, columns] of Object.entries({
    CreditAccount: [
      "monthlyUsageUsed",
      "purchasedCredits",
      "purchasedCreditDebt",
    ],
    CreditTransaction: ["creditAmount", "debtAmount", "usageAmount"],
    AiJob: ["usageUnits"],
  })) {
    const sums = columns.map(
      (column, index) =>
        `COALESCE(SUM("${column}"), 0)::DECIMAL(38,6)::TEXT AS "units${index}"`,
    );
    const result = await client.query(
      `SELECT COUNT(*)::TEXT AS "rowCount", ${sums.join(", ")} FROM "${table}"`,
    );
    totals[table] = result.rows[0];
  }
  return totals;
}

async function verifyLocks(client) {
  for (const table of BILLING_TABLES) {
    const { rows } = await client.query(`SHOW CREATE TABLE "${table}"`);
    if (!rows[0]?.create_statement?.includes("schema_locked = true")) {
      throw new Error(`${table} is not schema-locked; keep writers stopped`);
    }
  }
}

export async function runAiUsageMigration({
  client,
  migrations,
  writersStopped = false,
  checkOnly = false,
  deploy,
}) {
  const { rows } = await client.query(
    'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at',
  );
  const pending = pendingAiUsageMigrations(migrations, rows);
  const needsMaintenance = pending.some((name) => BILLING_MIGRATIONS.has(name));
  if (checkOnly) return { pending, needsMaintenance };
  if (pending.length === 0) {
    await verifyLocks(client);
    return { pending, needsMaintenance };
  }
  if (needsMaintenance && !writersStopped) {
    throw new Error(
      "Stop and drain Web/API/Admin ledger writes, Stripe webhooks, callbacks, and scheduled reconcilers, then rerun with --writers-stopped. See docs/ai-actual-cost-billing.md#migration-cutover",
    );
  }
  if (needsMaintenance) {
    const active = await client.query(
      `SELECT COUNT(*)::TEXT AS "count" FROM "AiJob" WHERE status IN ('queued', 'running', 'finalizing')`,
    );
    if (active.rows[0]?.count !== "0") {
      throw new Error(
        "Active AI jobs remain; drain them before stopping completion writers and applying migrations",
      );
    }
  }

  const before = needsMaintenance ? await readLedgerTotals(client) : null;
  try {
    if (pending.includes(ACTUAL_COST_MIGRATION) && !pending.includes(UNLOCK_MIGRATION)) {
      // Failure recovery relocks these tables, but Prisma will not replay the
      // already-applied unlock migration. Reopen only the pending DDL's guards,
      // after maintenance checks and inside the relock-on-failure boundary.
      for (const table of ["AiOperationModel", "AiJob"]) {
        await client.query(`ALTER TABLE "${table}" SET (schema_locked = false)`);
      }
    }
    await deploy();
    if (before !== null) {
      const after = await readLedgerTotals(client);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error(
          "Ledger row counts or unit totals changed during migration; keep writers stopped and investigate",
        );
      }
    }
    await verifyLocks(client);
  } catch (error) {
    // A failed DDL batch may already have unlocked some tables. Restore the
    // schema ownership guard without marking the failed migration as applied.
    const failures = [];
    for (const table of BILLING_TABLES) {
      try {
        await client.query(`ALTER TABLE "${table}" SET (schema_locked = true)`);
      } catch (relockError) {
        failures.push(relockError);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        "Migration failed and some schema locks could not be restored; keep writers stopped",
      );
    }
    throw error;
  }
  return { applied: pending, needsMaintenance };
}
