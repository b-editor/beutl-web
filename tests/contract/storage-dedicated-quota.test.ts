import { beforeEach, describe, expect, it } from "vitest";
import { createFileWithStorageQuota, setDbProvider } from "@beutl/db";
import { STORAGE_FILE_COUNT_LIMIT, STORAGE_QUOTA_BYTES } from "@beutl/core";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

describe("dedicated storage quota invariant", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;
  beforeEach(() => { memory = createInMemoryPrisma(); setDbProvider(async () => memory.prisma as never); });

  it("counts unfinished multipart reservations in quota", async () => {
    await memory.prisma.storageUpload.create({ data: { id: "reservation", userId: "u", objectKey: "r", uploadId: "m", name: "r", mimeType: "x", size: BigInt(STORAGE_QUOTA_BYTES), partSize: 1 } } as never);
    await expect(createFileWithStorageQuota({ userId: "u", name: "new", objectKey: "new", size: 1, mimeType: "x", visibility: "DEDICATED", quotaBytes: BigInt(STORAGE_QUOTA_BYTES), fileCountLimit: STORAGE_FILE_COUNT_LIMIT })).resolves.toMatchObject({ kind: "overQuota" });
  });

  it("enforces the file-count limit transactionally", async () => {
    for (let i = 0; i < STORAGE_FILE_COUNT_LIMIT; i++) memory.state.files.set(`f-${i}`, { id: `f-${i}`, userId: "u", objectKey: `f-${i}`, name: `f-${i}`, size: 1, mimeType: "x", visibility: "DEDICATED", sha256: null, createdAt: new Date(), updatedAt: new Date() });
    await expect(createFileWithStorageQuota({ userId: "u", name: "new", objectKey: "new", size: 1, mimeType: "x", visibility: "DEDICATED", quotaBytes: BigInt(STORAGE_QUOTA_BYTES), fileCountLimit: STORAGE_FILE_COUNT_LIMIT })).resolves.toMatchObject({ kind: "tooManyFiles" });
  });

  it("does not credit a non-atomic artifact replacement at the last slot", async () => {
    memory.state.files.set("old-artifact", {
      id: "old-artifact",
      userId: "u",
      objectKey: "old-object",
      name: "old.bin",
      size: 1,
      mimeType: "x",
      visibility: "DEDICATED",
      sha256: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(createFileWithStorageQuota({
      userId: "u",
      name: "replacement.bin",
      objectKey: "replacement-object",
      size: 1,
      mimeType: "x",
      visibility: "DEDICATED",
      quotaBytes: BigInt(STORAGE_QUOTA_BYTES),
      fileCountLimit: 1,
    })).resolves.toMatchObject({ kind: "tooManyFiles" });
  });
});
