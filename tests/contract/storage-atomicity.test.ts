import { beforeEach, describe, expect, it, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  reserveStorageUpload: vi.fn(),
  finalizeStorageUpload: vi.fn(),
  markStorageCleanupReady: vi.fn(),
  retrieveFilesByUserId: vi.fn(),
  claimDueStorageCleanups: vi.fn(),
  storageCleanupHasReferences: vi.fn(),
  cancelClaimedStorageCleanup: vi.fn(),
  completeClaimedStorageCleanup: vi.fn(),
  deferClaimedStorageCleanup: vi.fn(),
  put: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock("@beutl/db", () => ({
  reserveStorageUpload: storageMocks.reserveStorageUpload,
  finalizeStorageUpload: storageMocks.finalizeStorageUpload,
  markStorageCleanupReady: storageMocks.markStorageCleanupReady,
  retrieveFilesByUserId: storageMocks.retrieveFilesByUserId,
  claimDueStorageCleanups: storageMocks.claimDueStorageCleanups,
  storageCleanupHasReferences: storageMocks.storageCleanupHasReferences,
  cancelClaimedStorageCleanup: storageMocks.cancelClaimedStorageCleanup,
  completeClaimedStorageCleanup: storageMocks.completeClaimedStorageCleanup,
  deferClaimedStorageCleanup: storageMocks.deferClaimedStorageCleanup,
}));

import {
  createStorageFile,
  drainStorageCleanup,
} from "@/lib/storage";

const bucket = {
  put: storageMocks.put,
  delete: storageMocks.deleteObject,
};

const storedRecord = {
  id: "file-id",
  objectKey: "object-key",
  name: "extension.nupkg",
  size: 7n,
  mimeType: "application/octet-stream",
  userId: "user-id",
  visibility: "DEDICATED",
  sha256: "sha256",
};

const claimedCleanup = {
  id: "cleanup-id",
  fileId: "file-id",
  objectKey: "object-key",
  leaseId: "lease-id",
};

describe("durable storage publication and cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageMocks.retrieveFilesByUserId.mockResolvedValue([]);
    storageMocks.reserveStorageUpload.mockResolvedValue({});
    storageMocks.put.mockResolvedValue({});
    storageMocks.finalizeStorageUpload.mockResolvedValue(storedRecord);
    storageMocks.markStorageCleanupReady.mockResolvedValue(true);
    storageMocks.claimDueStorageCleanups.mockResolvedValue([]);
    storageMocks.storageCleanupHasReferences.mockResolvedValue(false);
    storageMocks.deleteObject.mockResolvedValue(undefined);
    storageMocks.cancelClaimedStorageCleanup.mockResolvedValue(undefined);
    storageMocks.completeClaimedStorageCleanup.mockResolvedValue(undefined);
    storageMocks.deferClaimedStorageCleanup.mockResolvedValue(undefined);
  });

  it("reserves durable cleanup before R2 and publishes File only afterward", async () => {
    const order: string[] = [];
    storageMocks.reserveStorageUpload.mockImplementation(async () => {
      order.push("reserve");
    });
    storageMocks.put.mockImplementation(async () => {
      order.push("r2-put");
    });
    storageMocks.finalizeStorageUpload.mockImplementation(async () => {
      order.push("db-finalize");
      return storedRecord;
    });

    const result = await createStorageFile({
      file: new File(["package"], "extension.nupkg", {
        type: "application/octet-stream",
      }),
      visibility: "DEDICATED",
      userId: "user-id",
      pendingReference: true,
      bucket,
    });

    expect(result).toBe(storedRecord);
    expect(order).toEqual(["reserve", "r2-put", "db-finalize"]);
    expect(storageMocks.finalizeStorageUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingReference: true,
        file: expect.objectContaining({
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it("makes a failed R2 upload immediately drainable and awaits cleanup", async () => {
    storageMocks.put.mockRejectedValue(new Error("R2 unavailable"));
    storageMocks.claimDueStorageCleanups.mockResolvedValue([claimedCleanup]);
    let finishDeletion: (() => void) | undefined;
    storageMocks.deleteObject.mockReturnValue(
      new Promise<void>((resolve) => {
        finishDeletion = resolve;
      }),
    );

    const operation = createStorageFile({
      file: new File(["package"], "extension.nupkg"),
      visibility: "DEDICATED",
      userId: "user-id",
      bucket,
    });
    await vi.waitFor(() => expect(storageMocks.deleteObject).toHaveBeenCalled());
    expect(storageMocks.markStorageCleanupReady).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: expect.any(String) }),
    );
    finishDeletion?.();
    await expect(operation).rejects.toThrow("R2 unavailable");
    expect(storageMocks.finalizeStorageUpload).not.toHaveBeenCalled();
  });

  it("recovers an object when the File transaction fails", async () => {
    storageMocks.finalizeStorageUpload.mockRejectedValue(
      new Error("database unavailable"),
    );
    storageMocks.claimDueStorageCleanups.mockResolvedValue([claimedCleanup]);

    await expect(
      createStorageFile({
        file: new File(["package"], "extension.nupkg"),
        visibility: "DEDICATED",
        userId: "user-id",
        bucket,
      }),
    ).rejects.toThrow("database unavailable");

    expect(storageMocks.put).toHaveBeenCalledOnce();
    expect(storageMocks.deleteObject).toHaveBeenCalledWith("object-key");
    expect(storageMocks.completeClaimedStorageCleanup).toHaveBeenCalledWith(
      claimedCleanup,
    );
  });

  it("retains and defers the outbox row when R2 deletion fails", async () => {
    storageMocks.claimDueStorageCleanups.mockResolvedValue([claimedCleanup]);
    storageMocks.deleteObject.mockRejectedValue(new Error("R2 unavailable"));

    await expect(drainStorageCleanup({ bucket })).resolves.toMatchObject({
      claimed: 1,
      deleted: 0,
      deferred: 1,
      failureCounts: { R2_DELETE_FAILED: 1 },
    });
    expect(storageMocks.deferClaimedStorageCleanup).toHaveBeenCalledWith({
      cleanup: claimedCleanup,
      errorCode: "R2_DELETE_FAILED",
    });
    expect(storageMocks.completeClaimedStorageCleanup).not.toHaveBeenCalled();
  });

  it("deletes the File/outbox only after awaited R2 deletion", async () => {
    storageMocks.claimDueStorageCleanups.mockResolvedValue([claimedCleanup]);
    let finishDeletion: (() => void) | undefined;
    storageMocks.deleteObject.mockReturnValue(
      new Promise<void>((resolve) => {
        finishDeletion = resolve;
      }),
    );

    const operation = drainStorageCleanup({ bucket });
    await vi.waitFor(() => expect(storageMocks.deleteObject).toHaveBeenCalled());
    expect(storageMocks.completeClaimedStorageCleanup).not.toHaveBeenCalled();
    finishDeletion?.();
    await expect(operation).resolves.toMatchObject({ deleted: 1, deferred: 0 });
    expect(storageMocks.completeClaimedStorageCleanup).toHaveBeenCalledOnce();
  });

  it("retries idempotently without surfacing duplicate R2 delete failures", async () => {
    storageMocks.claimDueStorageCleanups.mockResolvedValue([claimedCleanup]);
    storageMocks.deleteObject
      .mockRejectedValueOnce(new Error("transient delete failure"))
      .mockResolvedValueOnce(undefined);

    await expect(drainStorageCleanup({ bucket })).resolves.toMatchObject({
      deleted: 0,
      deferred: 1,
    });
    await expect(drainStorageCleanup({ bucket })).resolves.toMatchObject({
      deleted: 1,
      deferred: 0,
    });
    expect(storageMocks.deleteObject).toHaveBeenCalledTimes(2);
    expect(storageMocks.deferClaimedStorageCleanup).toHaveBeenCalledOnce();
    expect(storageMocks.completeClaimedStorageCleanup).toHaveBeenCalledOnce();
  });

  it("cancels cleanup without touching R2 when a shared File is referenced", async () => {
    storageMocks.claimDueStorageCleanups.mockResolvedValue([claimedCleanup]);
    storageMocks.storageCleanupHasReferences.mockResolvedValue(true);

    await expect(drainStorageCleanup({ bucket })).resolves.toMatchObject({
      cancelled: 1,
      deleted: 0,
      deferred: 0,
    });
    expect(storageMocks.cancelClaimedStorageCleanup).toHaveBeenCalledWith(
      claimedCleanup,
    );
    expect(storageMocks.deleteObject).not.toHaveBeenCalled();
  });
});
