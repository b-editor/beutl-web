import { describe, expect, it } from "vitest";
import {
  enqueueUserStorageCleanups,
  setDbProvider,
  StorageCleanupBusyError,
} from "@beutl/db";

type Written = {
  created: string[];
  multipartHandles?: Array<{ objectKey: string; uploadId: string }>;
  updated: string[];
  batches: number;
  calls?: number;
};

function call(written: Written): void {
  written.calls = (written.calls ?? 0) + 1;
}

function providerFor(
  files: string[],
  uploads: string[],
  written: Written,
  completedUploads = false,
): void {
  setDbProvider(async () => ({
    file: {
      findMany: async () => {
        call(written);
        return files.map((objectKey) => ({ objectKey }));
      },
    },
    storageUpload: {
      findMany: async () => {
        call(written);
        return uploads.map((objectKey, index) => ({
          id: `storage-upload-${index}`,
          userId: "user-1",
          objectKey,
          uploadId: `mp-${objectKey}`,
          completedFileId: completedUploads ? `file-${objectKey}` : null,
          abandonedAt: null,
          createdAt: new Date("2026-08-08T00:00:00.000Z"),
          startState: "active",
          creationLeaseUntil: null,
          creationLeaseToken: null,
        }));
      },
      updateMany: async () => {
        call(written);
        return { count: 1 };
      },
    },
    storageMultipartCleanup: {
      createMany: async (args: {
        data: Array<{ objectKey: string; uploadId: string }>;
      }) => {
        call(written);
        written.multipartHandles?.push(...args.data);
        return { count: args.data.length };
      },
    },
    aiStorageCleanup: {
      findMany: async () => {
        call(written);
        return [];
      },
      createMany: async (args: {
        data: { objectKey: string }[];
        skipDuplicates: boolean;
      }) => {
        call(written);
        written.batches++;
        for (const row of args.data) {
          written.created.push(row.objectKey);
        }
        return { count: args.data.length };
      },
      updateMany: async (args: {
        where: { objectKey: { in: string[] } | string };
        data?: { notBefore?: Date };
      }) => {
        call(written);
        const keys = typeof args.where.objectKey === "string"
          ? [args.where.objectKey]
          : args.where.objectKey.in;
        if (args.data?.notBefore !== undefined) {
          for (const key of keys) written.updated.push(key);
        }
        return { count: keys.length };
      },
    },
  }) as never);
}

describe("account storage cleanup preparation", () => {
  const now = new Date("2026-08-09T00:00:00.000Z");

  it("durably queues every user-owned object before account deletion", async () => {
    const written: Written = {
      created: [],
      multipartHandles: [],
      updated: [],
      batches: 0,
    };
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
    expect(written.updated).toEqual([]);
  });

  it("queues an upload whose object exists with no file to point at it", async () => {
    // R2 で組み上がったあと、控えを書く前に落ちたもの。行ごと消してしまうと、
    // その出来上がったオブジェクトを指す手掛かりはどこにも残らない。
    const written: Written = {
      created: [],
      multipartHandles: [],
      updated: [],
      batches: 0,
    };
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
    expect(written.multipartHandles).toEqual([
      {
        objectKey: "packages/user-1/archive",
        uploadId: "mp-packages/user-1/archive",
        leaseToken: null,
        notBefore: now,
        attempts: 0,
        lastError: null,
        interventionAt: null,
        status: "pending",
        revision: 0,
      },
      {
        objectKey: "storage/user-1/half-written",
        uploadId: "mp-storage/user-1/half-written",
        leaseToken: null,
        notBefore: now,
        attempts: 0,
        lastError: null,
        interventionAt: null,
        status: "pending",
        revision: 0,
      },
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
    expect(written.calls).toBeLessThan(100);
  });

  it("keeps completed receipts batched without multipart merge calls", async () => {
    const keys = Array.from({ length: 10_000 }, (_, index) => `receipt-${index}`);
    const written: Written = {
      created: [],
      multipartHandles: [],
      updated: [],
      batches: 0,
    };
    providerFor(keys, keys, written, true);

    await expect(
      enqueueUserStorageCleanups({ userId: "user-1", now }),
    ).resolves.toBe(10_000);
    expect(written.calls).toBeLessThan(100);
    expect(written.multipartHandles).toEqual([]);
  });

  it("freezes and detaches every handle that shares one object key", async () => {
    const objectKey = "storage/user-1/shared";
    const rows = ["multipart-a", "multipart-b"].map((uploadId, index) => ({
      id: `upload-${index}`,
      userId: "user-1",
      objectKey,
      uploadId,
      completedFileId: null,
      abandonedAt: null as Date | null,
      createdAt: new Date(`2026-08-08T00:00:0${index}.000Z`),
      startState: "active",
      creationLeaseUntil: null,
      creationLeaseToken: null,
    }));
    const handles: Array<{ objectKey: string; uploadId: string }> = [];
    const objectCleanups: string[] = [];
    setDbProvider(async () => ({
      file: { findMany: async () => [] },
      storageUpload: {
        findMany: async () => rows,
        updateMany: async ({ where, data }: { where: { id: string }; data: { abandonedAt: Date } }) => {
          const row = rows.find((candidate) => candidate.id === where.id);
          if (!row || row.abandonedAt) return { count: 0 };
          row.abandonedAt = data.abandonedAt;
          return { count: 1 };
        },
      },
      storageMultipartCleanup: {
        createMany: async ({ data }: { data: typeof handles }) => {
          handles.push(...data);
          return { count: data.length };
        },
      },
      aiStorageCleanup: {
        findMany: async () => [],
        createMany: async ({ data }: { data: Array<{ objectKey: string }> }) => {
          objectCleanups.push(...data.map((item) => item.objectKey));
          return { count: data.length };
        },
        updateMany: async () => ({ count: 0 }),
      },
    }) as never);

    await expect(enqueueUserStorageCleanups({ userId: "user-1", now }))
      .resolves.toBe(1);
    expect(rows.every((row) => row.abandonedAt?.getTime() === now.getTime()))
      .toBe(true);
    expect(handles).toEqual([
      {
        objectKey,
        uploadId: "multipart-a",
        leaseToken: null,
        notBefore: now,
        attempts: 0,
        lastError: null,
        interventionAt: null,
        status: "pending",
        revision: 0,
      },
      {
        objectKey,
        uploadId: "multipart-b",
        leaseToken: null,
        notBefore: now,
        attempts: 0,
        lastError: null,
        interventionAt: null,
        status: "pending",
        revision: 0,
      },
    ]);
    expect(objectCleanups).toEqual([objectKey]);
  });

  it("freezes a live null-id creator before the User cascade", async () => {
    const objectKey = "storage/user-1/creating";
    const row = {
      id: "upload-creating",
      userId: "user-1",
      objectKey,
      uploadId: null,
      completedFileId: null,
      abandonedAt: null as Date | null,
      createdAt: new Date("2026-08-08T00:00:00.000Z"),
      startState: "creating",
      creationLeaseUntil: new Date("2026-08-09T00:05:00.000Z"),
      creationLeaseToken: "live-creator",
    };
    let multipartWrites = 0;
    setDbProvider(async () => ({
      file: { findMany: async () => [] },
      storageUpload: {
        findMany: async () => [row],
        updateMany: async ({ data }: { data: { abandonedAt: Date } }) => {
          row.abandonedAt = data.abandonedAt;
          return { count: 1 };
        },
      },
      storageMultipartCleanup: {
        createMany: async () => {
          multipartWrites++;
          return { count: 0 };
        },
      },
      aiStorageCleanup: {
        findMany: async () => [],
        createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }),
        updateMany: async () => ({ count: 0 }),
      },
    }) as never);

    await expect(enqueueUserStorageCleanups({ userId: "user-1", now }))
      .resolves.toBe(1);
    expect(row.abandonedAt).toEqual(now);
    expect(row.creationLeaseToken).toBe("live-creator");
    expect(multipartWrites).toBe(0);
  });

  it("blocks an unfinished upload from mutating an active cleanup lease", async () => {
    const objectKey = "ai/image/job-1/output";
    const lease = new Date(now.getTime() + 5 * 60 * 1000);
    const updates: { where: unknown; data: unknown }[] = [];
    const existing = {
      objectKey,
      aiJobId: "job-1",
      state: "cleanup",
      notBefore: lease,
    };
    setDbProvider(async () => ({
      file: { findMany: async () => [{ objectKey }] },
      storageUpload: {
        findMany: async () => [{
          id: "upload-1",
          userId: "user-1",
          objectKey,
          uploadId: "multipart-1",
          completedFileId: null,
          abandonedAt: null,
          createdAt: new Date("2026-08-08T00:00:00.000Z"),
          startState: "active",
          creationLeaseUntil: null,
          creationLeaseToken: null,
        }],
        updateMany: async () => ({ count: 1 }),
      },
      storageMultipartCleanup: {
        createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }),
      },
      aiStorageCleanup: {
        findMany: async () => [{
          ...existing,
          leaseToken: "claim-token",
        }],
        createMany: async () => ({ count: 1 }),
        updateMany: async (args: { where: any; data: any }) => {
          updates.push(args);
          const where = args.where;
          const matchesLease =
            existing.notBefore <= now || existing.state === "writing";
          if (matchesLease) {
            existing.aiJobId = args.data.aiJobId;
            existing.state = args.data.state;
            existing.notBefore = args.data.notBefore;
          }
          if (where.NOT?.notBefore && existing.notBefore > now) {
            existing.aiJobId = args.data.aiJobId;
            existing.state = args.data.state;
          }
          return { count: 1 };
        },
      },
    }) as never);

    await expect(
      enqueueUserStorageCleanups({ userId: "user-1", now }),
    ).rejects.toBeInstanceOf(StorageCleanupBusyError);
    expect(existing.notBefore).toEqual(lease);
    expect(existing.state).toBe("cleanup");
    expect(updates).toHaveLength(0);
  });

  it("does not overwrite an expired cleanup lease owned by a cleaner", async () => {
    const objectKey = "ai/image/job-expired/output";
    const expired = new Date(now.getTime() - 1_000);
    const existing = {
      objectKey,
      aiJobId: "job-old",
      state: "cleanup",
      leaseToken: "expired-token",
      notBefore: expired,
    };
    let updateCalls = 0;
    setDbProvider(async () => ({
      file: { findMany: async () => [{ objectKey }] },
      storageUpload: {
        findMany: async () => [{
          id: "upload-1",
          userId: "user-1",
          objectKey,
          uploadId: "multipart-1",
          completedFileId: null,
          abandonedAt: null,
          createdAt: new Date("2026-08-08T00:00:00.000Z"),
          startState: "active",
          creationLeaseUntil: null,
          creationLeaseToken: null,
        }],
        updateMany: async () => ({ count: 1 }),
      },
      storageMultipartCleanup: {
        createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }),
      },
      aiStorageCleanup: {
        findMany: async () => [existing],
        createMany: async () => ({ count: 1 }),
        updateMany: async () => {
          updateCalls++;
          return { count: 1 };
        },
      },
    }) as never);

    await expect(
      enqueueUserStorageCleanups({ userId: "user-1", now }),
    ).rejects.toBeInstanceOf(StorageCleanupBusyError);
    expect(updateCalls).toBe(0);
  });
});
