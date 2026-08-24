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
      storageUpload: {
        findMany: async () => [],
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

  it("queues an upload whose object exists with no file to point at it", async () => {
    // R2 で組み上がったあと、控えを書く前に落ちたもの。行ごと消してしまうと、
    // その出来上がったオブジェクトを指す手掛かりはどこにも残らない。
    const queued: string[] = [];
    setDbProvider(async () => ({
      file: {
        findMany: async () => [{ objectKey: "packages/user-1/archive" }],
      },
      storageUpload: {
        findMany: async () => [
          // 控えが書かれたあとのものは File と同じ鍵を指す——二度数えない。
          { objectKey: "packages/user-1/archive" },
          { objectKey: "storage/user-1/half-written" },
        ],
      },
      aiStorageCleanup: {
        upsert: async (args: { where: { objectKey: string } }) => {
          queued.push(args.where.objectKey);
          return args;
        },
      },
    }) as never);

    await expect(
      enqueueUserStorageCleanups({
        userId: "user-1",
        now: new Date("2026-08-09T00:00:00.000Z"),
      }),
    ).resolves.toBe(2);
    expect(queued).toEqual([
      "packages/user-1/archive",
      "storage/user-1/half-written",
    ]);
  });
});
