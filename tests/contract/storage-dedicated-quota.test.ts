import { beforeEach, describe, expect, it } from "vitest";
import {
  commitDedicatedStorageReservation,
  createDedicatedStorageReservation,
  createFileWithStorageQuota,
  setDbProvider,
} from "@beutl/db";
import { STORAGE_FREE_FILE_COUNT_LIMIT, STORAGE_FREE_QUOTA_BYTES } from "@beutl/core";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

describe("dedicated storage quota invariant", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;
  beforeEach(() => { memory = createInMemoryPrisma(); setDbProvider(async () => memory.prisma as never); });

  it("counts unfinished multipart reservations in quota", async () => {
    await memory.prisma.storageUpload.create({ data: { id: "reservation", userId: "u", objectKey: "r", uploadId: "m", name: "r", mimeType: "x", size: BigInt(STORAGE_FREE_QUOTA_BYTES), partSize: 1 } } as never);
    await expect(createFileWithStorageQuota({ userId: "u", name: "new", objectKey: "new", size: 1, mimeType: "x", visibility: "DEDICATED", quotaBytes: BigInt(STORAGE_FREE_QUOTA_BYTES), fileCountLimit: STORAGE_FREE_FILE_COUNT_LIMIT })).resolves.toMatchObject({ kind: "overQuota" });
  });

  it("enforces the file-count limit transactionally", async () => {
    for (let i = 0; i < STORAGE_FREE_FILE_COUNT_LIMIT; i++) memory.state.files.set(`f-${i}`, { id: `f-${i}`, userId: "u", objectKey: `f-${i}`, name: `f-${i}`, size: 1, mimeType: "x", visibility: "DEDICATED", sha256: null, createdAt: new Date(), updatedAt: new Date() });
    await expect(createFileWithStorageQuota({ userId: "u", name: "new", objectKey: "new", size: 1, mimeType: "x", visibility: "DEDICATED", quotaBytes: BigInt(STORAGE_FREE_QUOTA_BYTES), fileCountLimit: STORAGE_FREE_FILE_COUNT_LIMIT })).resolves.toMatchObject({ kind: "tooManyFiles" });
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
      quotaBytes: BigInt(STORAGE_FREE_QUOTA_BYTES),
      fileCountLimit: 1,
    })).resolves.toMatchObject({ kind: "tooManyFiles" });
  });

  it("refuses the commit when the plan lapsed after the reservation", async () => {
    // Reserved under a paid quota, committed after the account fell back to
    // the free one: the File is not created, and the caller releases the
    // reservation so the object it already wrote is cleaned up.
    const twoGiB = BigInt(2) * BigInt(1024 ** 3);
    const reserved = await createDedicatedStorageReservation({
      userId: "u",
      id: "reservation",
      objectKey: "object",
      name: "icon.png",
      mimeType: "image/png",
      size: twoGiB,
      quotaBytes: BigInt(100) * BigInt(1024 ** 3),
      fileCountLimit: 100_000,
    });
    expect(reserved.kind).toBe("reserved");

    await expect(
      commitDedicatedStorageReservation({ userId: "u", id: "reservation", objectKey: "object" }),
    ).resolves.toEqual({ kind: "overQuota" });
    expect(memory.state.files.size).toBe(0);
    expect(memory.state.storageUploads.get("reservation")).toMatchObject({ completedFileId: null });
  });
});
