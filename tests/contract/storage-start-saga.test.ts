import { beforeEach, describe, expect, it } from "vitest";
import {
  attachStorageUploadRemote,
  claimStorageUploadCreation,
  claimStorageUploadForAbandon,
  createStorageUploadIntent,
  deleteClaimedStorageUpload,
  deleteStorageUpload,
  findStorageUploadByIdAndUserId,
  listStorageUploadsStartedBefore,
  releaseStorageUploadCreation,
  setDbProvider,
} from "@beutl/db";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

describe("durable storage-upload start saga", () => {
  const userId = "saga-user";
  let state: ReturnType<typeof createInMemoryPrisma>["state"];

  beforeEach(() => {
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
  });

  async function intent(id = crypto.randomUUID()) {
    await createStorageUploadIntent({
      userId,
      id,
      objectKey: `storage-upload/${userId}/${id}`,
      name: "saga.bin",
      mimeType: "application/octet-stream",
      size: BigInt(10),
      partSize: 10,
    });
    return id;
  }

  function abandonExpectation(
    upload: NonNullable<
      Awaited<ReturnType<typeof findStorageUploadByIdAndUserId>>
    >,
  ) {
    return {
      createdAt: upload.createdAt,
      objectKey: upload.objectKey,
      uploadId: upload.uploadId,
      name: upload.name,
      mimeType: upload.mimeType,
      size: upload.size,
      partSize: upload.partSize,
      abandonedAt: upload.abandonedAt,
      startState: upload.startState,
      creationLeaseUntil: upload.creationLeaseUntil,
      creationLeaseToken: upload.creationLeaseToken,
      cleanupLeaseUntil: upload.cleanupLeaseUntil,
      cleanupLeaseToken: upload.cleanupLeaseToken,
    };
  }

  it("rejects an old creator token after lease reclaim", async () => {
    const id = await intent();
    const now = new Date();
    expect(await claimStorageUploadCreation({
      id, userId, now, leaseUntil: new Date(now.getTime() - 1), leaseToken: "A",
    })).toBe(true);
    expect(await claimStorageUploadCreation({
      id, userId, now, leaseUntil: new Date(now.getTime() + 60_000), leaseToken: "B",
    })).toBe(true);
    expect(await attachStorageUploadRemote({ id, userId, uploadId: "remote-A", leaseToken: "A" })).toBe(false);
    expect(await attachStorageUploadRemote({ id, userId, uploadId: "remote-B", leaseToken: "B" })).toBe(true);
    expect((await findStorageUploadByIdAndUserId({ id, userId }))?.uploadId).toBe("remote-B");
  });

  it("rejects attachment after cancellation claims the intent", async () => {
    const id = await intent();
    const now = new Date();
    expect(await claimStorageUploadCreation({
      id, userId, now, leaseUntil: new Date(now.getTime() + 60_000), leaseToken: "A",
    })).toBe(true);
    const current = await findStorageUploadByIdAndUserId({ id, userId });
    expect(current).not.toBeNull();
    expect(await claimStorageUploadForAbandon({
      id,
      userId,
      now,
      cleanupLeaseToken: "cleanup-a",
      cleanupLeaseUntil: new Date(now.getTime() + 60_000),
      expected: abandonExpectation(current!),
    })).toBe(true);
    expect(await attachStorageUploadRemote({ id, userId, uploadId: "remote-A", leaseToken: "A" })).toBe(false);
  });

  it("does not let an old sweeper release a newer creator lease", async () => {
    const id = await intent();
    const now = new Date();
    expect(await claimStorageUploadCreation({
      id, userId, now, leaseUntil: new Date(now.getTime() - 1), leaseToken: "A",
    })).toBe(true);
    expect(await claimStorageUploadCreation({
      id, userId, now, leaseUntil: new Date(now.getTime() + 60_000), leaseToken: "B",
    })).toBe(true);
    expect(await releaseStorageUploadCreation({ id, now, leaseToken: "A" })).toBe(false);
    expect((await findStorageUploadByIdAndUserId({ id, userId }))?.creationLeaseToken).toBe("B");
  });

  it("does not claim a stale list snapshot after its remote handle is attached", async () => {
    const id = await intent();
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 60_000);
    const [listed] = await listStorageUploadsStartedBefore({
      before: new Date(now.getTime() + 1),
      now,
      limit: 1,
    });
    expect(listed?.uploadId).toBeNull();

    expect(await claimStorageUploadCreation({
      id, userId, now, leaseUntil, leaseToken: "creator",
    })).toBe(true);

    expect(await attachStorageUploadRemote({
      id,
      userId,
      uploadId: "remote-current",
      leaseToken: "creator",
    })).toBe(true);
    expect(await claimStorageUploadForAbandon({
      id,
      userId,
      now: new Date(now.getTime() + 2),
      cleanupLeaseToken: "cleanup-stale",
      cleanupLeaseUntil: new Date(now.getTime() + 60_000),
      expected: abandonExpectation(listed!),
    })).toBe(false);

    const current = await findStorageUploadByIdAndUserId({ id, userId });
    expect(current).toMatchObject({
      uploadId: "remote-current",
      startState: "active",
      abandonedAt: null,
    });
  });

  it("does not abandon an old intent while its current creation lease is live", async () => {
    const id = await intent();
    const now = new Date();
    const row = state.storageUploads.get(id)!;
    row.createdAt = new Date(now.getTime() - 25 * 60 * 60_000);
    const leaseUntil = new Date(now.getTime() + 5 * 60_000);
    expect(await claimStorageUploadCreation({
      id,
      userId,
      now,
      leaseUntil,
      leaseToken: "fresh-creator",
    })).toBe(true);

    const listed = await listStorageUploadsStartedBefore({
      before: new Date(now.getTime() - 24 * 60 * 60_000),
      now,
      limit: 1,
    });
    expect(listed).toEqual([]);
    const current = await findStorageUploadByIdAndUserId({ id, userId });
    expect(current).not.toBeNull();
    expect(await claimStorageUploadForAbandon({
      id,
      userId,
      now,
      cleanupLeaseToken: "cleanup-live",
      cleanupLeaseUntil: new Date(now.getTime() + 60_000),
      requireExpiredCreationLease: true,
      expected: abandonExpectation(current!),
    })).toBe(false);
    expect(state.storageUploads.get(id)).toMatchObject({
      abandonedAt: null,
      creationLeaseToken: "fresh-creator",
    });

    expect(await claimStorageUploadForAbandon({
      id,
      userId,
      now: new Date(leaseUntil.getTime() + 1),
      cleanupLeaseToken: "cleanup-expired",
      cleanupLeaseUntil: new Date(leaseUntil.getTime() + 60_000),
      requireExpiredCreationLease: true,
      expected: abandonExpectation(current!),
    })).toBe(true);
  });

  it("does not claim a replacement row from an identical old snapshot", async () => {
    const id = await intent("reused-id");
    const original = await findStorageUploadByIdAndUserId({ id, userId });
    expect(original).not.toBeNull();
    await deleteStorageUpload({ id });
    await intent(id);
    const replacement = state.storageUploads.get(id)!;
    replacement.createdAt = new Date(original!.createdAt.getTime() + 1);

    expect(await claimStorageUploadForAbandon({
      id,
      userId,
      now: new Date(),
      cleanupLeaseToken: "cleanup-replacement",
      cleanupLeaseUntil: new Date(Date.now() + 60_000),
      expected: abandonExpectation(original!),
    })).toBe(false);
    expect(state.storageUploads.get(id)?.abandonedAt).toBeNull();
  });

  it("does not delete a same-id replacement after an old cleanup claim", async () => {
    const id = await intent("delete-reused-id");
    const original = await findStorageUploadByIdAndUserId({ id, userId });
    expect(original).not.toBeNull();
    const now = new Date();
    expect(await claimStorageUploadForAbandon({
      id,
      userId,
      now,
      cleanupLeaseToken: "old-cleaner",
      cleanupLeaseUntil: new Date(now.getTime() + 60_000),
      expected: abandonExpectation(original!),
    })).toBe(true);
    const claimed = await findStorageUploadByIdAndUserId({ id, userId });
    expect(claimed?.abandonedAt).not.toBeNull();

    await deleteStorageUpload({ id });
    await intent(id);
    const replacement = state.storageUploads.get(id)!;
    replacement.createdAt = new Date(claimed!.createdAt.getTime() + 1);

    await expect(deleteClaimedStorageUpload({
      id,
      userId,
      expected: {
        ...abandonExpectation(claimed!),
        abandonedAt: claimed!.abandonedAt!,
      },
    })).resolves.toBe(false);
    expect(state.storageUploads.get(id)?.createdAt).toEqual(replacement.createdAt);
  });

  it("does not let cancellation act on an intent snapshot after attachment", async () => {
    const id = await intent();
    const now = new Date();
    expect(await claimStorageUploadCreation({
      id,
      userId,
      now,
      leaseUntil: new Date(now.getTime() + 60_000),
      leaseToken: "creator",
    })).toBe(true);
    const cancelSnapshot = await findStorageUploadByIdAndUserId({ id, userId });
    expect(cancelSnapshot).not.toBeNull();

    expect(await attachStorageUploadRemote({
      id,
      userId,
      uploadId: "remote-attached-during-cancel",
      leaseToken: "creator",
    })).toBe(true);
    expect(await claimStorageUploadForAbandon({
      id,
      userId,
      now: new Date(now.getTime() + 1),
      cleanupLeaseToken: "cleanup-cancel",
      cleanupLeaseUntil: new Date(now.getTime() + 60_000),
      expected: abandonExpectation(cancelSnapshot!),
    })).toBe(false);

    expect(await findStorageUploadByIdAndUserId({ id, userId })).toMatchObject({
      uploadId: "remote-attached-during-cancel",
      abandonedAt: null,
    });
  });

  it("does not let leased rows consume the stale sweep page", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 25 * 60 * 60_000);
    for (let index = 0; index < 100; index++) {
      const id = await intent(`leased-${index}`);
      const row = state.storageUploads.get(id)!;
      state.storageUploads.set(id, {
        ...row,
        createdAt: old,
        abandonedAt: old,
        cleanupLeaseToken: `cleaner-${index}`,
        cleanupLeaseUntil: new Date(now.getTime() + 60_000),
      });
    }
    const eligibleId = await intent("eligible-after-leases");
    state.storageUploads.get(eligibleId)!.createdAt = old;
    const liveCreatorId = await intent("live-creator-before-page");
    const liveCreator = state.storageUploads.get(liveCreatorId)!;
    state.storageUploads.set(liveCreatorId, {
      ...liveCreator,
      createdAt: old,
      startState: "creating",
      creationLeaseToken: "live-creator",
      creationLeaseUntil: new Date(now.getTime() + 60_000),
    });

    const listed = await listStorageUploadsStartedBefore({
      before: new Date(now.getTime() - 24 * 60 * 60_000),
      now,
      limit: 100,
    });

    expect(listed.map((row) => row.id)).toEqual([eligibleId]);
  });
});
