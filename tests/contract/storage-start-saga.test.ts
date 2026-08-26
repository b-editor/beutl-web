import { beforeEach, describe, expect, it } from "vitest";
import {
  attachStorageUploadRemote,
  claimStorageUploadCreation,
  claimStorageUploadForAbandon,
  createStorageUploadIntent,
  findStorageUploadByIdAndUserId,
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
    expect(await claimStorageUploadForAbandon({ id, userId, now })).toBe(true);
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
});
