import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationsUrl = new URL(
  "../../apps/web/prisma/migrations/",
  import.meta.url,
);

describe("Prisma migration chain", () => {
  it("defines FeedbackStatus and Feedback.status exactly once", async () => {
    const directories = await readdir(migrationsUrl, { withFileTypes: true });
    const migrations = (
      await Promise.all(
        directories
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => ({
            name: entry.name,
            sql: await readFile(
              new URL(`${entry.name}/migration.sql`, migrationsUrl),
              "utf8",
            ),
          })),
      )
    );

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
});
