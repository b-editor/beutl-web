import { describe, expect, it } from "vitest";
import { enqueueUserStorageCleanups, setDbProvider } from "@beutl/db";

type Written = { created: string[]; updated: string[]; batches: number };

function providerFor(
  files: string[],
  uploads: string[],
  written: Written,
): void {
  setDbProvider(async () => ({
    file: {
      findMany: async () => files.map((objectKey) => ({ objectKey })),
    },
    storageUpload: {
      findMany: async () => uploads.map((objectKey) => ({ objectKey, uploadId: `mp-${objectKey}` })),
    },
    aiStorageCleanup: {
      createMany: async (args: {
        data: { objectKey: string }[];
        skipDuplicates: boolean;
      }) => {
        written.batches++;
        for (const row of args.data) written.created.push(row.objectKey);
        return { count: args.data.length };
      },
      updateMany: async (args: {
        where: { objectKey: { in: string[] } };
      }) => {
        for (const key of args.where.objectKey.in) written.updated.push(key);
        return { count: args.where.objectKey.in.length };
      },
    },
  }) as never);
}

describe("account storage cleanup preparation", () => {
  const now = new Date("2026-08-09T00:00:00.000Z");

  it("durably queues every user-owned object before account deletion", async () => {
    const written: Written = { created: [], updated: [], batches: 0 };
    providerFor(
      ["ai/image/job-1/output", "packages/user-1/archive"],
      [],
      written,
    );

    await expect(
      enqueueUserStorageCleanups({ userId: "user-1", now }),
    ).resolves.toBe(2);

    expect(written.created).toEqual([
      "ai/image/job-1/output",
      "packages/user-1/archive",
    ]);
    // 既にあった行も、いま置きたい状態へ揃える。
    expect(written.updated).toEqual(written.created);
  });

  it("queues an upload whose object exists with no file to point at it", async () => {
    // R2 で組み上がったあと、控えを書く前に落ちたもの。行ごと消してしまうと、
    // その出来上がったオブジェクトを指す手掛かりはどこにも残らない。
    const written: Written = { created: [], updated: [], batches: 0 };
    providerFor(
      ["packages/user-1/archive"],
      // 控えが書かれたあとのものは File と同じ鍵を指す——二度数えない。
      ["packages/user-1/archive", "storage/user-1/half-written"],
      written,
    );

    await expect(
      enqueueUserStorageCleanups({ userId: "user-1", now }),
    ).resolves.toBe(2);

    expect(written.created).toEqual([
      "packages/user-1/archive",
      "storage/user-1/half-written",
    ]);
  });

  it("writes in batches rather than one round trip per object", async () => {
    // 上限いっぱいまでファイルを持つ利用者の削除が、1 万回の往復になっては
    // いけない——その全部がカスケードと同じトランザクションの中に入る。
    const written: Written = { created: [], updated: [], batches: 0 };
    providerFor(
      Array.from({ length: 10_000 }, (_, index) => `key-${index}`),
      [],
      written,
    );

    await expect(
      enqueueUserStorageCleanups({ userId: "user-1", now }),
    ).resolves.toBe(10_000);

    expect(written.created).toHaveLength(10_000);
    expect(written.batches).toBeLessThan(100);
  });
});
