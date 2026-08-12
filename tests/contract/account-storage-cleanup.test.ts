import { describe, expect, it } from "vitest";
import { enqueueUserStorageCleanups, setDbProvider } from "@beutl/db";

describe("account storage cleanup preparation", () => {
  it("durably queues every user-owned object before account deletion", async () => {
    const intents: Array<Record<string, unknown>> = [];
    setDbProvider(async () => ({
      file: {
        findMany: async () => [
          { objectKey: "ai/image/job-1/output" },
          { objectKey: "packages/user-1/archive" },
        ],
      },
      aiStorageCleanup: {
        upsert: async (args: Record<string, unknown>) => {
          intents.push(args);
          return args;
        },
      },
    }) as never);
    const now = new Date("2026-08-09T00:00:00.000Z");

    await expect(
      enqueueUserStorageCleanups({ userId: "user-1", now }),
    ).resolves.toBe(2);

    expect(intents).toEqual([
      {
        where: { objectKey: "ai/image/job-1/output" },
        create: {
          objectKey: "ai/image/job-1/output",
          aiJobId: null,
          state: "cleanup",
          notBefore: now,
        },
        update: {
          aiJobId: null,
          state: "cleanup",
          notBefore: now,
        },
      },
      {
        where: { objectKey: "packages/user-1/archive" },
        create: {
          objectKey: "packages/user-1/archive",
          aiJobId: null,
          state: "cleanup",
          notBefore: now,
        },
        update: {
          aiJobId: null,
          state: "cleanup",
          notBefore: now,
        },
      },
    ]);
  });
});
