import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
import { setR2BucketProvider } from "@beutl/api";
import {
  STORAGE_FREE_QUOTA_BYTES,
  STORAGE_PAID_FILE_COUNT_LIMIT,
} from "@beutl/core";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

// A bucket that joins parts by summing what was put. Only what the plan
// enforcement needs; the full multipart contract lives in
// storage-chunked-upload.test.ts.
const bucket = vi.hoisted(() => {
  const uploads = new Map<string, { key: string; parts: Map<number, number> }>();
  let nextId = 1;
  const deleted: string[] = [];
  return {
    uploads,
    deleted,
    createMultipartUpload: vi.fn(async (key: string) => {
      const uploadId = `upload-${nextId++}`;
      uploads.set(uploadId, { key, parts: new Map() });
      return { uploadId, uploadPart: vi.fn(), complete: vi.fn(), abort: vi.fn() };
    }),
    resumeMultipartUpload: vi.fn((key: string, uploadId: string) => ({
      uploadPart: async (partNumber: number, body: ReadableStream<Uint8Array>) => {
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) throw new Error("no such upload");
        let size = 0;
        const reader = body.getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
        }
        upload.parts.set(partNumber, size);
        return { partNumber, etag: `etag-${partNumber}` };
      },
      complete: async (parts: { partNumber: number; etag: string }[]) => {
        const upload = uploads.get(uploadId);
        if (!upload) throw new Error("no such upload");
        let size = 0;
        for (const part of parts) size += upload.parts.get(part.partNumber) ?? 0;
        return { size };
      },
      abort: async () => undefined,
    })),
    delete: vi.fn(async (key: string) => {
      deleted.push(key);
    }),
    head: vi.fn(async () => null),
  };
});

import {
  finishUpload,
  startUpload,
  uploadPart,
} from "../../apps/web/src/lib/storage-upload-server";
import { reconcileUnknownStorageUploadCompletions } from "../../packages/api/src/storage-uploads";

const USER_ID = "plan-user";
const GIB = 1024 * 1024 * 1024;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
const PAST = new Date(Date.now() - 60 * 1_000);

function streamOf(size: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}

describe("storage plan enforcement on uploads", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    vi.restoreAllMocks();
    bucket.uploads.clear();
    bucket.deleted.length = 0;
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    setR2BucketProvider(() => bucket as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function subscribe(tier: string, overrides: Record<string, unknown> = {}) {
    memory.state.subscriptions.set(`${USER_ID}:storage`, {
      userId: USER_ID,
      stripeSubscriptionId: "sub_storage",
      status: "active",
      planId: "storage",
      tier: tier,
      billingOfferId: "offer_storage",
      currentPeriodStart: PAST,
      currentPeriodEnd: FUTURE,
      cancelAtPeriodEnd: false,
      cancelAt: null,
      stripeEventId: null,
      stripeEventCreatedAt: null,
      stripeCanonicalObservedAt: null,
      stripeObservationRank: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });
  }

  function seedFiles(count: number, size = 1) {
    for (let index = 0; index < count; index++) {
      memory.state.files.set(`seed-${index}`, {
        id: `seed-${index}`,
        userId: USER_ID,
        objectKey: `seed-${index}`,
        name: `seed-${index}`,
        size,
        mimeType: "application/octet-stream",
        visibility: "PRIVATE",
        sha256: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);
    }
  }

  const start = (size: bigint) =>
    startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "big.bin",
      mimeType: "application/octet-stream",
      size,
    });

  it("refuses a file beyond the free quota and admits it on a paid tier", async () => {
    const size = BigInt(Math.floor(1.5 * GIB));
    const free = await start(size);
    expect(free).toEqual({ ok: false, reason: "insufficientStorageSpace" });

    subscribe("100gb");
    const paid = await start(size);
    expect(paid.ok).toBe(true);
  });

  it("reads the plan inside the start transaction", async () => {
    subscribe("100gb");
    const read = vi.spyOn(memory.prisma.subscription, "findUnique");
    const transaction = vi.spyOn(memory.prisma, "$transaction");
    const outcome = await start(BigInt(2 * GIB));
    expect(outcome.ok).toBe(true);
    expect(read).toHaveBeenCalled();
    expect(transaction).toHaveBeenCalled();
    // The read happened while a transaction was open, not before it.
    expect(read.mock.invocationCallOrder[0]).toBeGreaterThan(
      transaction.mock.invocationCallOrder[0],
    );
  });

  it("refuses the completion when the plan lapsed after the start", async () => {
    subscribe("100gb");
    const started = await start(BigInt(4_000));
    if (!started.ok) throw new Error(started.reason);
    // Push the file over the free line with a stored file, then lapse.
    seedFiles(1, STORAGE_FREE_QUOTA_BYTES - 1_000);
    await uploadPart({
      userId: USER_ID,
      uploadId: started.upload.id,
      partNumber: 1,
      body: streamOf(4_000),
      contentLength: 4_000,
    });
    subscribe("100gb", { currentPeriodEnd: PAST });

    const finished = await finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    });

    expect(finished).toEqual({ ok: false, reason: "insufficientStorageSpace" });
    expect(memory.state.files.size).toBe(1);
    // The assembled object is not left behind.
    expect(bucket.deleted.length + memory.state.storageMultipartCleanups.size).toBeGreaterThan(0);
  });

  it("raises the file count limit for a paid tier", async () => {
    subscribe("200gb");
    seedFiles(STORAGE_PAID_FILE_COUNT_LIMIT);
    await expect(start(BigInt(1))).resolves.toEqual({
      ok: false,
      reason: "tooManyFiles",
    });
    memory.state.files.delete("seed-0");
    expect((await start(BigInt(1))).ok).toBe(true);
    // Seeding a hundred thousand rows is the point of the test; give it room
    // when the machine is busy with the rest of the suite.
  }, 30_000);

  it("still lets an over-quota lapsed account delete files", async () => {
    // Deleting reads no quota at all; this pins that nothing in the delete
    // path was made to depend on the plan.
    seedFiles(1, 2 * GIB);
    const { deleteFileWithStorageCleanup } = await import("@beutl/db");
    await expect(
      deleteFileWithStorageCleanup({ id: "seed-0", userId: USER_ID } as never),
    ).resolves.toBeDefined();
    expect(memory.state.files.size).toBe(0);
  });

  it("uses the paid quota when recovering an unknown completion", async () => {
    subscribe("100gb");
    const started = await start(BigInt(2 * GIB));
    if (!started.ok) throw new Error(started.reason);
    const row = memory.state.storageUploads.get(started.upload.id)!;
    memory.state.storageUploads.set(row.id, {
      ...row,
      completionState: "unknown",
      unknownProbeNotBefore: new Date(Date.now() - 1_000),
      unknownProbeLeaseToken: null,
      completionLeaseUntil: null,
      completionLeaseToken: null,
    });
    bucket.head.mockResolvedValueOnce({ key: row.objectKey, size: 2 * GIB } as never);

    const outcome = await reconcileUnknownStorageUploadCompletions();

    expect(outcome.finalized).toBe(1);
    expect([...memory.state.files.values()][0]?.size).toBe(2 * GIB);
  });

  it("cleans up an unknown completion the lapsed plan can no longer hold", async () => {
    subscribe("100gb");
    const started = await start(BigInt(2 * GIB));
    if (!started.ok) throw new Error(started.reason);
    const row = memory.state.storageUploads.get(started.upload.id)!;
    memory.state.storageUploads.set(row.id, {
      ...row,
      completionState: "unknown",
      unknownProbeNotBefore: new Date(Date.now() - 1_000),
      unknownProbeLeaseToken: null,
      completionLeaseUntil: null,
      completionLeaseToken: null,
    });
    // The plan lapses before the probe sees the assembled 2 GiB object.
    subscribe("100gb", { currentPeriodEnd: PAST });
    bucket.head.mockResolvedValue({ key: row.objectKey, size: 2 * GIB } as never);

    const outcome = await reconcileUnknownStorageUploadCompletions();

    expect(outcome).toMatchObject({ finalized: 0, abandoned: 1, errors: 0 });
    // No receipt, no row holding the reservation, and the object queued for
    // deletion rather than probed again on every run.
    expect(memory.state.files.size).toBe(0);
    expect(memory.state.storageUploads.has(row.id)).toBe(false);
    expect(memory.state.aiStorageCleanups.get(row.objectKey)).toMatchObject({
      state: "cleanup",
    });
    expect(await reconcileUnknownStorageUploadCompletions()).toMatchObject({
      inspected: 0,
    });
  });
});
