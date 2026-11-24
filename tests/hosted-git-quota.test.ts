import { describe, expect, it, vi } from "vitest";
import { runWithDbProvider, extendGitLfsReservation, reserveGitLfs, reserveGitLfsBatch, createFileWithStorageQuota, createDedicatedStorageReservation, commitDedicatedStorageReservation, sumFileSizeByUserId, sumStorageUploadSizeByUserId } from "@beutl/db";
import { getStorageEntitlement } from "@beutl/api";
import { STORAGE_FREE_QUOTA_BYTES } from "@beutl/core";
import { createInMemoryPrisma } from "./stubs/in-memory-prisma";

describe("shared File and hosted Git storage admission", () => {
  it("extends only a pending LFS reservation", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const expiresAt = Date.parse("2026-10-05T00:00:00Z");
    await runWithDbProvider(async () => ({ gitLfsStorage: { updateMany } }) as never,
      () => extendGitLfsReservation("repo", "a".repeat(64), expiresAt));
    expect(updateMany).toHaveBeenCalledWith({ where: { repoId: "repo", oid: "a".repeat(64), verified: false },
      data: { expiresAt: new Date(expiresAt) } });
  });

  it.each(["history", "lfs"])("keeps pending %s bytes reserved when a dedicated file completes after a quota reduction", async (kind) => {
    const memory = createInMemoryPrisma(), userId = "owner";
    memory.state.files.set("existing", { id: "existing", userId, size: STORAGE_FREE_QUOTA_BYTES - 32,
      objectKey: "existing", visibility: "PRIVATE", name: "existing", mimeType: "application/octet-stream" } as never);
    await runWithDbProvider(async () => memory.prisma as never, async () => {
      // Both writes were admitted under the former, larger plan.
      const reserved = await createDedicatedStorageReservation({ userId, id: "upload", objectKey: "new",
        name: "new", mimeType: "application/octet-stream", size: 24n,
        quotaBytes: BigInt(STORAGE_FREE_QUOTA_BYTES) + 100n, fileCountLimit: 10_000 });
      expect(reserved.kind).toBe("reserved");
      memory.state.gitRepositories.set("repo", { ownerId: userId, deletedAt: null,
        historyBytes: 0n, historyReservedBytes: kind === "history" ? 16n : 0n } as never);
      if (kind === "lfs") memory.state.gitLfsStorage.set("repo:pending", { ownerId: userId, verified: false, size: 16n });
      // The account now resolves to the free quota. The File alone fits, but
      // completing it must leave room for the pending Git reservation.
      expect(await commitDedicatedStorageReservation({ id: "upload", userId, objectKey: "new" })).toEqual({ kind: "overQuota" });
      expect(memory.state.files.size).toBe(1);
      expect(memory.state.storageUploads.get("upload")?.completedFileId).toBeNull();
    });
  });

  it("reflects committed Git/LFS and pending Git bytes in the existing API meter", async () => {
    const memory = createInMemoryPrisma(), userId = "owner";
    memory.state.gitRepositories.set("repo", { ownerId: userId, deletedAt: null,
      historyBytes: 5n, historyReservedBytes: 7n } as never);
    memory.state.gitLfsStorage.set("repo:verified", { ownerId: userId, verified: true, size: 11n });
    memory.state.gitLfsStorage.set("repo:pending", { ownerId: userId, verified: false, size: 13n });
    await runWithDbProvider(async () => memory.prisma as never, async () => {
      expect(await sumFileSizeByUserId({ userId })).toBe(16n);
      expect(await sumStorageUploadSizeByUserId({ userId })).toBe(20n);
      expect(await getStorageEntitlement(userId)).toMatchObject({ usedBytes: 16, fileCount: 0 });
    });
  });
  it("serializes File and LFS admission through the same account row and prevents double reservation", async () => {
    // This fake serializes transactions; actual CockroachDB contention is a deployment validation limit.
    const memory = createInMemoryPrisma(), userId = "owner", repoId = "repo";
    memory.state.files.set("existing", { id: "existing", userId, size: STORAGE_FREE_QUOTA_BYTES - 32,
      objectKey: "existing", visibility: "PRIVATE", name: "existing", mimeType: "application/octet-stream" } as never);
    const repo = { id: repoId, ownerId: userId, deletedAt: null, historyBytes: 0n, historyReservedBytes: 0n };
    memory.state.gitRepositories.set(repoId, repo as never);
    const prisma = memory.prisma as any;
    prisma.aiStorageCleanup.deleteMany = async () => ({ count: 1 });
    prisma.gitRepository.findFirst = async () => repo;
    prisma.gitLfsStorage.findUnique = async ({ where }: any) =>
      memory.state.gitLfsStorage.get(`${where.repoId_oid.repoId}:${where.repoId_oid.oid}`) ?? null;
    prisma.gitLfsStorage.create = async ({ data }: any) => {
      const row = { ...data, verified: false }; memory.state.gitLfsStorage.set(`${data.repoId}:${data.oid}`, row); return row;
    };
    await runWithDbProvider(async () => prisma, async () => {
      const [file, lfs] = await Promise.all([
        createFileWithStorageQuota({ userId, objectKey: "new", name: "new", mimeType: "application/octet-stream",
          visibility: "PRIVATE", size: 24, sha256: null, quotaBytes: BigInt(STORAGE_FREE_QUOTA_BYTES), fileCountLimit: 10_000 } as never),
        reserveGitLfs({ repoId, ownerId: userId, oid: "a".repeat(64), size: 24, expiresAt: Date.now() + 60_000 }),
      ]);
      expect(Number(file.kind === "overQuota") + Number(lfs === "overQuota")).toBe(1);
      expect(memory.state.storageRevisions.get(userId)).toBe(2);
      const total = await sumFileSizeByUserId({ userId }) + await sumStorageUploadSizeByUserId({ userId });
      expect(total <= BigInt(STORAGE_FREE_QUOTA_BYTES)).toBe(true);
    });
  });
});

describe("batched Git LFS storage admission", () => {
  const repoId = "repo", ownerId = "owner", expiresAt = Date.parse("2026-11-25T00:00:00Z");
  const item = (digit: string, size: number) => ({ oid: digit.repeat(64), size, expiresAt });

  function database() {
    const { prisma, state } = createInMemoryPrisma();
    const findFirst = vi.fn(async () => ({ id: repoId }));
    const findMany = vi.fn(async ({ where }: { where: { repoId: string; oid: { in: string[] } } }) =>
      where.oid.in.flatMap((oid) => {
        const row = state.gitLfsStorage.get(`${where.repoId}:${oid}`);
        return row ? [{ oid, ...row }] : [];
      }));
    const createMany = vi.fn(async ({ data }: { data: {
      repoId: string; oid: string; ownerId: string; size: bigint; expiresAt: Date;
    }[] }) => {
      for (const row of data) state.gitLfsStorage.set(`${row.repoId}:${row.oid}`, { ...row, verified: false });
      return { count: data.length };
    });
    Object.assign(prisma.gitRepository, { findFirst });
    Object.assign(prisma.gitLfsStorage, { findMany, createMany });
    const transaction = vi.spyOn(prisma, "$transaction");
    const lock = vi.spyOn(prisma.user, "update");
    const files = vi.spyOn(prisma.file, "aggregate");
    const subscription = vi.spyOn(prisma.subscription, "findUnique");
    const reserve = (items: Parameters<typeof reserveGitLfsBatch>[0]["items"], maxReservations?: number) =>
      runWithDbProvider(async () => prisma as never, () => reserveGitLfsBatch({ repoId, ownerId, items, maxReservations }));
    return { state, findFirst, findMany, createMany, transaction, lock, files, subscription, reserve };
  }

  it("reserves the objects that fit in one transaction and one insert", async () => {
    const db = database();
    const first = item("a", 6), existing = item("b", 3), tooLarge = item("c", 5), last = item("d", 4);
    db.state.files.set("file", { id: "file", userId: ownerId, size: STORAGE_FREE_QUOTA_BYTES - 13 } as never);
    db.state.gitLfsStorage.set(`${repoId}:${existing.oid}`, { ownerId, size: 3n, verified: true });

    const results = await db.reserve([first, existing, { ...first, expiresAt: expiresAt + 1000 }, tooLarge, last]);
    expect([...results]).toEqual([[first.oid, "reserved"], [existing.oid, "existing"], [tooLarge.oid, "overQuota"], [last.oid, "reserved"]]);
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(db.lock).toHaveBeenCalledExactlyOnceWith({ where: { id: ownerId }, data: { storageRevision: { increment: 1 } } });
    expect(db.findFirst).toHaveBeenCalledExactlyOnceWith({ where: { id: repoId, ownerId, deletedAt: null }, select: { id: true } });
    expect(db.findMany).toHaveBeenCalledExactlyOnceWith({ where: { repoId, oid: { in: [first.oid, existing.oid, tooLarge.oid, last.oid] } } });
    expect(db.files).toHaveBeenCalledOnce();
    expect(db.subscription).toHaveBeenCalledOnce();
    expect(db.createMany).toHaveBeenCalledExactlyOnceWith({ data: [first, last].map(({ oid, size }) =>
      ({ repoId, ownerId, oid, size: BigInt(size), expiresAt: new Date(expiresAt) })) });
  });

  it("reuses existing reservations without checking quota or inserting rows", async () => {
    const db = database(), existing = item("a", 3);
    db.state.gitLfsStorage.set(`${repoId}:${existing.oid}`, { ownerId, size: 3n, verified: false });
    expect(await db.reserve([existing, existing])).toEqual(new Map([[existing.oid, "existing"]]));
    expect(db.files).not.toHaveBeenCalled();
    expect(db.subscription).not.toHaveBeenCalled();
    expect(db.createMany).not.toHaveBeenCalled();
  });

  it.each(["existing size", "existing owner", "duplicate size"])("rejects a mismatched %s", async (mismatch) => {
    const db = database(), object = item("a", 3);
    if (mismatch !== "duplicate size") {
      db.state.gitLfsStorage.set(`${repoId}:${object.oid}`, { ownerId: mismatch === "existing owner" ? "another" : ownerId,
        size: mismatch === "existing size" ? 4n : 3n, verified: false });
    }
    const objects = mismatch === "duplicate size" ? [object, { ...object, size: 4 }] : [object];
    await expect(db.reserve([item("b", 1), ...objects])).rejects.toThrow("Git LFS reservation mismatch");
    expect(db.createMany).not.toHaveBeenCalled();
    expect(db.files).not.toHaveBeenCalled();
  });

  it("counts only admitted reservations against maxReservations when earlier items exceed quota", async () => {
    const db = database();
    const tooLarge = item("a", 20), fits = item("b", 5), overLimit = item("c", 1);
    db.state.files.set("file", { id: "file", userId: ownerId, size: STORAGE_FREE_QUOTA_BYTES - 10 } as never);

    const results = await db.reserve([tooLarge, fits, overLimit], 1);
    expect([...results]).toEqual([[tooLarge.oid, "overQuota"], [fits.oid, "reserved"], [overLimit.oid, "limitReached"]]);
    expect(db.createMany).toHaveBeenCalledExactlyOnceWith({
      data: [{ repoId, ownerId, oid: fits.oid, size: 5n, expiresAt: new Date(expiresAt) }],
    });
  });

  it("returns an empty result without opening the database", async () => {
    const provider = vi.fn(async () => createInMemoryPrisma().prisma as never);
    expect(await runWithDbProvider(provider, () => reserveGitLfsBatch({ repoId, ownerId, items: [] }))).toEqual(new Map());
    expect(provider).not.toHaveBeenCalled();
  });
});
