import { describe, expect, it, vi } from "vitest";
import {
  acquireFileStorageMoveLease,
  existsFileById,
  FILE_STORAGE_MOVE_LEASE_MILLISECONDS,
  releaseFileStorageMoveLease,
  renewFileStorageMoveLease,
} from "../../packages/db/src/file";

const now = new Date("2026-09-09T00:00:00.000Z");

describe("the lease a storage move holds on a File row", () => {
  it("is taken only when nobody holds it or the holder's time is up", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const outcome = await acquireFileStorageMoveLease({
      id: "file-1",
      leaseToken: "token-1",
      now,
      prisma: { file: { updateMany } } as never,
    });
    expect(outcome).toBe("acquired");
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "file-1",
        OR: [{ storageMoveLeaseUntil: null }, { storageMoveLeaseUntil: { lte: now } }],
      },
      data: {
        storageMoveLeaseToken: "token-1",
        storageMoveLeaseUntil: new Date(now.getTime() + FILE_STORAGE_MOVE_LEASE_MILLISECONDS),
      },
    });
  });

  it("tells a held lease apart from a deleted file", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUnique = vi.fn().mockResolvedValueOnce({ id: "file-1" }).mockResolvedValueOnce(null);
    const prisma = { file: { updateMany, findUnique } } as never;
    expect(await acquireFileStorageMoveLease({ id: "file-1", leaseToken: "t", now, prisma })).toBe("busy");
    expect(await acquireFileStorageMoveLease({ id: "file-1", leaseToken: "t", now, prisma })).toBe("gone");
  });

  it("renews only a lease it still holds and that has not run out", async () => {
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const prisma = { file: { updateMany } } as never;
    expect(await renewFileStorageMoveLease({ id: "file-1", leaseToken: "t", now, prisma })).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "file-1", storageMoveLeaseToken: "t", storageMoveLeaseUntil: { gt: now } },
      data: { storageMoveLeaseUntil: new Date(now.getTime() + FILE_STORAGE_MOVE_LEASE_MILLISECONDS) },
    });
    expect(await renewFileStorageMoveLease({ id: "file-1", leaseToken: "t", now, prisma })).toBe(false);
  });

  it("releases only the lease it holds", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    expect(await releaseFileStorageMoveLease({ id: "file-1", leaseToken: "t", prisma: { file: { updateMany } } as never })).toBe(false);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "file-1", storageMoveLeaseToken: "t" },
      data: { storageMoveLeaseToken: null, storageMoveLeaseUntil: null },
    });
  });

  it("reports whether the row still exists", async () => {
    const findUnique = vi.fn().mockResolvedValueOnce({ id: "file-1" }).mockResolvedValueOnce(null);
    const prisma = { file: { findUnique } } as never;
    expect(await existsFileById({ id: "file-1", prisma })).toBe(true);
    expect(await existsFileById({ id: "file-1", prisma })).toBe(false);
  });
});
