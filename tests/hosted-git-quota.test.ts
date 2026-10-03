import { describe, expect, it } from "vitest";
import { runWithDbProvider, reserveGitLfs, createFileWithStorageQuota, sumFileSizeByUserId, sumStorageUploadSizeByUserId } from "@beutl/db";
import { getStorageEntitlement } from "@beutl/api";
import { STORAGE_FREE_QUOTA_BYTES } from "@beutl/core";
import { createInMemoryPrisma } from "./stubs/in-memory-prisma";

describe("shared File and hosted Git storage admission", () => {
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
