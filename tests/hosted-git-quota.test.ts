import { describe, expect, it, vi } from "vitest";
import { runWithDbProvider, extendGitLfsReservation, reserveGitLfs, createFileWithStorageQuota, createDedicatedStorageReservation, commitDedicatedStorageReservation, sumFileSizeByUserId, sumStorageUploadSizeByUserId } from "@beutl/db";
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
