import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationsUrl = new URL(
  "../../apps/web/prisma/migrations/",
  import.meta.url,
);

async function readMigrations() {
  const directories = await readdir(migrationsUrl, { withFileTypes: true });
  return await Promise.all(
    directories
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ({
        name: entry.name,
        sql: await readFile(
          new URL(`${entry.name}/migration.sql`, migrationsUrl),
          "utf8",
        ),
      })),
  );
}

describe("Prisma migration chain", () => {
  it("defines FeedbackStatus and Feedback.status exactly once", async () => {
    const migrations = await readMigrations();

    const feedbackStatusType = migrations.filter(({ sql }) =>
      sql.includes('CREATE TYPE "FeedbackStatus"'),
    );
    const feedbackStatusColumn = migrations.filter(({ sql }) =>
      sql.includes('ALTER TABLE "Feedback" ADD COLUMN "status"'),
    );

    expect(feedbackStatusType.map(({ name }) => name)).toEqual([
      "20260810000000_add_feedback_status",
    ]);
    expect(feedbackStatusColumn.map(({ name }) => name)).toEqual([
      "20260810000000_add_feedback_status",
    ]);
  });

  it("adds the package payment amount columns exactly once", async () => {
    const migrations = await readMigrations();

    const amountColumn = migrations.filter(({ sql }) =>
      sql.includes('ADD COLUMN "stripePaymentAmount"'),
    );
    const currencyColumn = migrations.filter(({ sql }) =>
      sql.includes('ADD COLUMN "stripeCurrency"'),
    );

    // CreditTransaction gained the same pair of column names earlier, so both
    // lists are expected to hold two entries — one per table, never two per table.
    expect(amountColumn.map(({ name }) => name)).toEqual([
      "20260808120000_replace_subscription_credits_with_monthly_usage",
      "20260817000000_store_package_payment_amount",
    ]);
    expect(currencyColumn.map(({ name }) => name)).toEqual([
      "20260808120000_replace_subscription_credits_with_monthly_usage",
      "20260817000000_store_package_payment_amount",
    ]);
  });
});
