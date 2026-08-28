import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
import * as storageDb from "@beutl/db";
import { setR2BucketProvider } from "@beutl/api";
import {
  STORAGE_FILE_COUNT_LIMIT,
  STORAGE_QUOTA_BYTES,
  STORAGE_UPLOAD_PART_BYTES,
} from "@beutl/core";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

// The bucket a file is assembled in. R2 keeps the parts under an upload id and
// joins them when told to, which is what lets a file arrive as several requests.
const bucket = vi.hoisted(() => {
  const uploads = new Map<
    string,
    { key: string; parts: Map<number, number>; aborted: boolean }
  >();
  let nextId = 1;
  return {
    uploads,
    createMultipartUpload: vi.fn(async (key: string) => {
      const uploadId = `upload-${nextId++}`;
      uploads.set(uploadId, { key, parts: new Map(), aborted: false });
      return {
        uploadId,
        uploadPart: vi.fn(),
        complete: vi.fn(),
        abort: vi.fn(),
      };
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
        for (const part of parts) {
          const partSize = upload.parts.get(part.partNumber);
          if (partSize === undefined) throw new Error("missing part");
          size += partSize;
        }
        return { size };
      },
      abort: async () => {
        const upload = uploads.get(uploadId);
        if (upload) upload.aborted = true;
      },
    })),
    delete: vi.fn(async (key: string) => {
      if (bucketDeleteFails) throw new Error("delete unavailable");
      bucketDeleted.push(key);
      bucketObjects.delete(key);
    }),
    // 組み上がる前の multipart はオブジェクトを持たない。掃除がそれを
    // 「もう何も無い」と読むかどうかが、この一覧の分かれ目になる。
    head: vi.fn(async (key: string) => bucketObjects.get(key) ?? null),
  };
});
const bucketDeleted: string[] = [];
let bucketDeleteFails = false;
const bucketObjects = new Map<string, { key: string; size?: number }>();
const defaultCreateMultipartUpload = bucket.createMultipartUpload.getMockImplementation()!;
const defaultResumeMultipartUpload = bucket.resumeMultipartUpload.getMockImplementation()!;
const defaultDelete = bucket.delete.getMockImplementation()!;
const defaultHead = bucket.head.getMockImplementation()!;

import {
  cancelUpload,
  finishUpload,
  partCountOf,
  startUpload,
} from "../../apps/web/src/lib/storage-upload-server";
import { uploadPart } from "../../apps/web/src/lib/storage-upload-server";
import {
  abandonStaleStorageUploads,
} from "../../packages/api/src/storage-uploads";
import { reconcileAiStorageCleanups } from "../../packages/api/src/ai/storage";

const USER_ID = "user-storage";

function streamOf(size: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}

describe("uploading a file too large for one request", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];

  beforeEach(() => {
    vi.restoreAllMocks();
    bucket.createMultipartUpload.mockReset().mockImplementation(defaultCreateMultipartUpload);
    bucket.resumeMultipartUpload.mockReset().mockImplementation(defaultResumeMultipartUpload);
    bucket.delete.mockReset().mockImplementation(defaultDelete);
    bucket.head.mockReset().mockImplementation(defaultHead);
    bucket.uploads.clear();
    bucketDeleted.length = 0;
    bucketDeleteFails = false;
    bucketObjects.clear();
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
    setR2BucketProvider(() => bucket as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns at the completion deadline and durably records an unknown provider outcome", async () => {
    vi.useFakeTimers();
    const started = await startUpload({ userId: USER_ID, id: crypto.randomUUID(), name: "deadline.bin", mimeType: "application/octet-stream", size: BigInt(1) });
    if (!started.ok) throw new Error(started.reason);
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: () => new Promise<{ size: number }>(() => undefined),
      abort: vi.fn(),
    }));
    const pending = finishUpload({ userId: USER_ID, uploadId: started.upload.id, parts: [{ partNumber: 1, etag: "etag-1" }] });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toEqual({ ok: false, reason: "uploadFailed" });
    expect(state.storageUploads.get(started.upload.id)?.completionState).toBe("unknown");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not re-complete after a timed-out provider call commits late", async () => {
    vi.useFakeTimers();
    const started = await startUpload({ userId: USER_ID, id: crypto.randomUUID(), name: "late.bin", mimeType: "application/octet-stream", size: BigInt(4) });
    if (!started.ok) throw new Error(started.reason);
    let resolveComplete!: (value: { size: number }) => void;
    const complete = vi.fn(() => new Promise<{ size: number }>((resolve) => { resolveComplete = resolve; }));
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete,
      abort: vi.fn(),
    }));

    const pending = finishUpload({ userId: USER_ID, uploadId: started.upload.id, parts: [{ partNumber: 1, etag: "etag-1" }] });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toEqual({ ok: false, reason: "uploadFailed" });
    const unknown = state.storageUploads.get(started.upload.id)!;
    expect(unknown.completionState).toBe("unknown");

    const operator = await storageDb.resumeStorageUploadIntervention({
      id: unknown.id,
      userId: USER_ID,
      objectKey: unknown.objectKey,
      uploadId: unknown.uploadId,
      expectedRevision: unknown.completionRevision,
      expectedInterventionAt: unknown.completionInterventionAt!,
      operatorUserId: "operator-1",
      operatorReason: "Checked provider completion status",
      operatorEvidence: "Incident INC-200 confirms delayed response",
      now: new Date("2026-08-28T00:15:00.000Z"),
    });
    expect(operator.status).toBe("unsafe");
    expect(complete).toHaveBeenCalledTimes(1);

    bucketObjects.set(unknown.objectKey, { key: unknown.objectKey });
    resolveComplete({ size: 4 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(state.files.size).toBe(1);
    expect(state.storageUploads.get(unknown.id)?.completionState).toBe("settled");
    expect(bucketDeleted).toEqual([]);
  });

  it("keeps a late provider rejection unknown without authorizing another provider call", async () => {
    vi.useFakeTimers();
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "late-rejection.bin",
      mimeType: "application/octet-stream",
      size: BigInt(4),
    });
    if (!started.ok) throw new Error(started.reason);
    let rejectComplete!: (error: unknown) => void;
    const complete = vi.fn(() => new Promise<{ size: number }>((_, reject) => {
      rejectComplete = reject;
    }));
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete,
      abort: vi.fn(),
    }));

    const pending = finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toEqual({ ok: false, reason: "uploadFailed" });
    rejectComplete(new Error("provider response was lost"));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(state.storageUploads.get(started.upload.id)).toMatchObject({
      completionState: "unknown",
      completionLastError: "provider response was lost",
      abandonedAt: null,
      completedFileId: null,
    });
  });

  it("recovers a visible unknown completion after the originating runtime is gone", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "runtime-loss.bin",
      mimeType: "application/octet-stream",
      size: BigInt(4),
    });
    if (!started.ok) throw new Error(started.reason);
    const row = state.storageUploads.get(started.upload.id)!;
    state.storageUploads.set(row.id, {
      ...row,
      completionState: "unknown",
      completionAttempts: 1,
      completionLastError: "originating runtime ended",
      completionInterventionAt: new Date(),
      completionRevision: 1,
    });
    bucketObjects.set(row.objectKey, { key: row.objectKey, size: 4 });

    await expect(abandonStaleStorageUploads(new Date())).resolves.toEqual({
      abandoned: 0,
      failed: 0,
    });

    expect(bucket.resumeMultipartUpload).not.toHaveBeenCalled();
    expect(state.files.size).toBe(1);
    expect(state.storageUploads.get(row.id)).toMatchObject({
      completionState: "settled",
      completionInterventionAt: null,
      completionRetryNotBefore: null,
      completedFileId: expect.any(String),
    });
    expect(bucketDeleted).toEqual([]);
  });

  it.each(["false", "throw"] as const)("stops waiting when lease renewal returns %s", async (mode) => {
    vi.useFakeTimers();
    const started = await startUpload({ userId: USER_ID, id: crypto.randomUUID(), name: `renew-${mode}.bin`, mimeType: "application/octet-stream", size: BigInt(1) });
    if (!started.ok) throw new Error(started.reason);
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({ uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }), complete: () => new Promise<{ size: number }>(() => undefined), abort: vi.fn() }));
    if (mode === "false") vi.spyOn(storageDb, "renewStorageUploadCompletion").mockResolvedValueOnce(false);
    else vi.spyOn(storageDb, "renewStorageUploadCompletion").mockRejectedValueOnce(new Error("renew unavailable"));
    const pending = finishUpload({ userId: USER_ID, uploadId: started.upload.id, parts: [{ partNumber: 1, etag: "etag-1" }] });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toEqual({ ok: false, reason: "uploadFailed" });
    expect(state.storageUploads.get(started.upload.id)).toMatchObject({ completionState: "completing", completedFileId: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cuts a file into parts the platform will carry", () => {
    // Every part but the last is the same size, which is what the bucket
    // requires, and none of them is anywhere near the 100 MB a request stops at.
    expect(STORAGE_UPLOAD_PART_BYTES).toBeLessThan(100 * 1024 * 1024);
    expect(partCountOf(BigInt(STORAGE_UPLOAD_PART_BYTES))).toBe(1);
    expect(partCountOf(BigInt(STORAGE_UPLOAD_PART_BYTES + 1))).toBe(2);
    expect(partCountOf(BigInt(STORAGE_QUOTA_BYTES))).toBe(
      Math.ceil(STORAGE_QUOTA_BYTES / STORAGE_UPLOAD_PART_BYTES),
    );
  });

  it("refuses a part longer than the size the upload was admitted for", async () => {
    // Otherwise an upload declaring nothing still holds parts of any length in
    // the bucket for a day, and none of it was counted against the quota.
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "empty.bin",
      mimeType: "application/octet-stream",
      size: BigInt(0),
    });
    if (!started.ok) throw new Error(started.reason);

    const outcome = await uploadPart({
      userId: USER_ID,
      uploadId: started.upload.id,
      partNumber: 1,
      contentLength: 8 * 1024 * 1024,
      body: streamOf(8 * 1024 * 1024),
    });

    expect(outcome).toEqual({
      ok: false,
      reason: "insufficientStorageSpace",
    });
  });

  it("takes a file in parts and stores it as one", async () => {
    const size = STORAGE_UPLOAD_PART_BYTES + 1_000;
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(size),
    });
    if (!started.ok) throw new Error(started.reason);
    expect(started.upload.partCount).toBe(2);

    const first = await uploadPart({
      userId: USER_ID,
      uploadId: started.upload.id,
      partNumber: 1,
      contentLength: STORAGE_UPLOAD_PART_BYTES,
      body: streamOf(STORAGE_UPLOAD_PART_BYTES),
    });
    const second = await uploadPart({
      userId: USER_ID,
      uploadId: started.upload.id,
      partNumber: 2,
      contentLength: 1_000,
      body: streamOf(1_000),
    });
    if (!first.ok || !second.ok) throw new Error("a part was refused");

    const finished = await finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [
        { partNumber: 1, etag: first.etag },
        { partNumber: 2, etag: second.etag },
      ],
    });

    expect(finished).toMatchObject({ ok: true });
    if (!finished.ok) return;
    // The file is one object, sized by what actually arrived.
    expect(finished.file.size).toBe(BigInt(size));
    expect(state.files.size).toBe(1);
    // The row stays as the receipt of a finished upload, pointing at what it
    // made. Nothing is under way any more, and the sweep clears the receipt.
    const receipt = [...state.storageUploads.values()][0];
    expect(receipt?.completedFileId).toBe(finished.file.id);

    // Only the answer went missing: asking again gives the same file rather
    // than storing the same bytes a second time.
    const again = await finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [
        { partNumber: 1, etag: first.etag },
        { partNumber: 2, etag: second.etag },
      ],
    });
    expect(again).toMatchObject({ ok: true });
    if (!again.ok) return;
    expect(again.file.id).toBe(finished.file.id);
    expect(state.files.size).toBe(1);
  });

  it("keeps a completion receipt across cancel and returns the same File", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "completed-before-cancel.bin",
      mimeType: "application/octet-stream",
      size: BigInt(4),
    });
    if (!started.ok) throw new Error(started.reason);
    const part = await uploadPart({
      userId: USER_ID,
      uploadId: started.upload.id,
      partNumber: 1,
      contentLength: 4,
      body: streamOf(4),
    });
    if (!part.ok) throw new Error(part.reason);
    const parts = [{ partNumber: 1, etag: part.etag }];
    const completed = await finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts,
    });
    if (!completed.ok) throw new Error(completed.reason);

    expect(await cancelUpload({ userId: USER_ID, uploadId: started.upload.id }))
      .toBe("cancelled");
    const retried = await finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts,
    });

    expect(retried).toMatchObject({ ok: true });
    if (!retried.ok) return;
    expect(retried.file.id).toBe(completed.file.id);
    expect(state.files.size).toBe(1);
    expect(state.storageUploads.get(started.upload.id)?.completedFileId)
      .toBe(completed.file.id);
  });

  it("refuses a part for an upload that is not the caller's", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);

    // Knowing an upload id is not the same as owning it, and the bucket would
    // take the part from anyone.
    const outcome = await uploadPart({
      userId: "someone-else",
      uploadId: started.upload.id,
      partNumber: 1,
      contentLength: 10,
      body: streamOf(10),
    });

    expect(outcome).toEqual({ ok: false, reason: "uploadNotFound" });
  });

  it("counts what is already on its way against the quota", async () => {
    const half = BigInt(STORAGE_QUOTA_BYTES) / BigInt(2);
    const first = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "one.bin",
      mimeType: "application/octet-stream",
      size: half + BigInt(1),
    });
    expect(first.ok).toBe(true);

    // Two uploads started at once would each see only what is stored, and
    // together they would pass the quota.
    const second = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "two.bin",
      mimeType: "application/octet-stream",
      size: half + BigInt(1),
    });

    expect(second).toEqual({ ok: false, reason: "insufficientStorageSpace" });
  });

  it("throws away what it cannot join", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(STORAGE_UPLOAD_PART_BYTES + 10),
    });
    if (!started.ok) throw new Error(started.reason);
    await uploadPart({
      userId: USER_ID,
      uploadId: started.upload.id,
      partNumber: 1,
      contentLength: STORAGE_UPLOAD_PART_BYTES,
      body: streamOf(STORAGE_UPLOAD_PART_BYTES),
    });

    // The second part never arrived, so there is no file to make. The provider
    // rejection is non-terminal, however: keep the completion fence and handle
    // for a later retry instead of aborting on an unproven HEAD absence.
    const finished = await finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [
        { partNumber: 1, etag: "etag-1" },
        { partNumber: 2, etag: "etag-2" },
      ],
    });

    expect(finished).toEqual({ ok: false, reason: "uploadFailed" });
    expect(state.files.size).toBe(0);
    expect(state.storageUploads.size).toBe(1);
    expect([...bucket.uploads.values()].every((upload) => upload.aborted)).toBe(false);
  });

  it("gives up an upload the browser abandoned", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);

    expect(await cancelUpload({ userId: USER_ID, uploadId: started.upload.id }))
      .toBe("cancelled");
    expect(state.storageUploads.size).toBe(0);
    expect([...bucket.uploads.values()].every((upload) => upload.aborted)).toBe(true);
  });

  it("uses a new object generation when the same client id is reused", async () => {
    const id = crypto.randomUUID();
    const first = await startUpload({
      userId: USER_ID,
      id,
      name: "first.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    });
    if (!first.ok) throw new Error(first.reason);
    const firstKey = state.storageUploads.get(id)!.objectKey;
    expect(await cancelUpload({ userId: USER_ID, uploadId: id }))
      .toBe("cancelled");

    const second = await startUpload({
      userId: USER_ID,
      id,
      name: "second.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    });
    if (!second.ok) throw new Error(second.reason);
    const secondKey = state.storageUploads.get(id)!.objectKey;

    expect(firstKey).not.toBe(secondKey);
    expect(firstKey).toMatch(new RegExp(`^storage-upload/${USER_ID}/${id}/`));
    expect(secondKey).toMatch(new RegExp(`^storage-upload/${USER_ID}/${id}/`));
  });

  it("sweeps up what was left behind a day later", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    // An unfinished upload holds its parts, and their storage, until something
    // abandons it.
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);

    const swept = await abandonStaleStorageUploads(tomorrow);

    expect(swept).toEqual({ abandoned: 1, failed: 0 });
    expect(state.storageUploads.size).toBe(0);
    expect([...bucket.uploads.values()].every((upload) => upload.aborted)).toBe(true);
  });

  it("keeps active completion fenced, then escalates an expired lease", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "in-flight-completion.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    const row = state.storageUploads.get(started.upload.id)!;
    const activeLease = new Date(Date.now() + 5 * 60_000);
    state.storageUploads.set(row.id, {
      ...row,
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      completionState: "completing",
      completionLeaseUntil: activeLease,
      completionLeaseToken: "completion-owner-a",
    });

    await expect(abandonStaleStorageUploads(new Date())).resolves.toEqual({
      abandoned: 0,
      failed: 0,
    });
    await expect(storageDb.enqueueUserStorageCleanups({
      userId: USER_ID,
      now: new Date(),
    })).rejects.toBeInstanceOf(storageDb.StorageCleanupBusyError);

    expect(state.storageUploads.get(row.id)).toMatchObject({
      completionLeaseToken: "completion-owner-a",
      completionState: "completing",
      abandonedAt: null,
      cleanupLeaseToken: null,
    });
    state.storageUploads.set(row.id, {
      ...state.storageUploads.get(row.id)!,
      completionLeaseUntil: new Date(Date.now() - 1),
    });
    await expect(abandonStaleStorageUploads(new Date())).resolves.toEqual({ abandoned: 0, failed: 0 });
    expect(state.storageUploads.get(row.id)).toMatchObject({
      completionState: "unknown",
      completionLeaseToken: null,
      completionLeaseUntil: null,
      abandonedAt: null,
    });
    await expect(storageDb.enqueueUserStorageCleanups({ userId: USER_ID, now: new Date() })).rejects.toBeInstanceOf(storageDb.StorageCleanupBusyError);
    expect(bucketDeleted).toEqual([]);
  });

  it("keeps the row when an abort fails and nothing was there to clear", async () => {
    // 中止に失敗する理由は「もう組み上がっている」だけではない。パートのままの
    // multipart はオブジェクトを持たないので、一時の不調で失敗しただけのときも
    // 「何も無い」と同じ顔をする——そこで行を消すと、中止に必要な uploadId ごと
    // 失われ、パートは誰にも消せないまま残る。
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => ({ size: 0 }),
      abort: async () => {
        throw new Error("the bucket is unreachable");
      },
    }));

    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const swept = await abandonStaleStorageUploads(tomorrow);

    expect(swept).toEqual({ abandoned: 0, failed: 1 });
    expect(state.storageUploads.size).toBe(1);
  });

  it("deletes an object that appears after a terminal stale-sweep abort", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "joined-terminal.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    const [tracked] = [...state.storageUploads.values()];
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => ({ size: 0 }),
      abort: async () => {
        throw Object.assign(new Error("NoSuchUpload"), { code: "NoSuchUpload" });
      },
    }));

    const settlementStartedAt = Date.now();
    const sweepNow = new Date(settlementStartedAt + 25 * 60 * 60 * 1000);
    await expect(abandonStaleStorageUploads(sweepNow))
      .resolves.toEqual({ abandoned: 1, failed: 0 });
    expect(bucketDeleted).toEqual([]);
    expect(state.storageUploads.size).toBe(0);
    const cleanup = state.aiStorageCleanups.get(tracked!.objectKey)!;
    expect(cleanup.notBefore.getTime()).toBeGreaterThanOrEqual(
      settlementStartedAt +
        storageDb.STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS,
    );
    bucketObjects.set(tracked!.objectKey, { key: tracked!.objectKey });

    await expect(reconcileAiStorageCleanups(cleanup.notBefore)).resolves.toEqual({
      inspected: 1,
      deleted: 1,
      errors: 0,
    });
    expect(bucketDeleted).toEqual([tracked!.objectKey]);
  });

  it("retains delayed object cleanup when deletion fails", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "joined-terminal-retry.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    const [tracked] = [...state.storageUploads.values()];
    bucketObjects.set(tracked!.objectKey, { key: tracked!.objectKey });
    bucketDeleteFails = true;
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => ({ size: 0 }),
      abort: async () => {
        throw Object.assign(new Error("NoSuchUpload"), { code: "NoSuchUpload" });
      },
    }));

    const sweepNow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await expect(abandonStaleStorageUploads(sweepNow))
      .resolves.toEqual({ abandoned: 1, failed: 0 });
    expect(state.storageUploads.size).toBe(0);
    const cleanup = state.aiStorageCleanups.get(tracked!.objectKey)!;
    await expect(reconcileAiStorageCleanups(cleanup.notBefore)).resolves.toEqual({
      inspected: 1,
      deleted: 0,
      errors: 1,
    });
    expect(state.aiStorageCleanups.has(tracked!.objectKey)).toBe(true);
  });

  it("keeps the cleanup row and object when abort failure sees a joined object", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "joined-before-receipt.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    const [tracked] = [...state.storageUploads.values()];
    bucketObjects.set(tracked!.objectKey, { key: tracked!.objectKey });
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => ({ size: 0 }),
      abort: async () => {
        throw new Error("the bucket is unreachable");
      },
    }));

    const swept = await abandonStaleStorageUploads(
      new Date(Date.now() + 25 * 60 * 60 * 1000),
    );

    expect(swept).toEqual({ abandoned: 0, failed: 1 });
    expect(state.storageUploads.size).toBe(1);
    expect([...state.storageUploads.values()][0]?.uploadId).toBeTruthy();
    expect(bucketDeleted).toHaveLength(0);
    expect(bucketObjects.has(tracked!.objectKey)).toBe(true);
  });

  it("does not let an overlapping stale sweep delete a same-id winner", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "aba-winner.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    const original = state.storageUploads.get(started.upload.id)!;
    original.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    let aborts = 0;
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => ({ size: 0 }),
      abort: async () => {
        aborts++;
        state.storageUploads.delete(original.id);
        state.storageUploads.set(original.id, {
          ...original,
          uploadId: "multipart-winner",
          createdAt: new Date(original.createdAt.getTime() + 1),
          abandonedAt: null,
          cleanupLeaseToken: null,
          cleanupLeaseUntil: null,
        });
        bucketObjects.set(original.objectKey, { key: original.objectKey });
        throw Object.assign(new Error("NoSuchUpload"), {
          code: "NoSuchUpload",
        });
      },
    }));
    const now = new Date();

    const results = await Promise.all([
      abandonStaleStorageUploads(now),
      abandonStaleStorageUploads(now),
    ]);

    expect(aborts).toBe(1);
    expect(results.reduce((sum, result) => sum + result.abandoned, 0)).toBe(0);
    expect(bucketDeleted).toEqual([]);
    expect(bucketObjects.has(original.objectKey)).toBe(true);
    expect(state.storageUploads.get(original.id)).toMatchObject({
      uploadId: "multipart-winner",
      abandonedAt: null,
    });
  });

  it("leaves the object of an upload that finished while the sweep ran", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    const [tracked] = [...state.storageUploads.values()];
    // 一覧を引いたあと、順番が回ってくるまでに完了した。行はもう控えなので、
    // そのオブジェクトは File のもの——捨てるものは何も残っていない。
    state.storageUploads.set(tracked!.id, {
      ...tracked!,
      completedFileId: "file-1",
    });
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);

    const swept = await abandonStaleStorageUploads(tomorrow);

    expect(swept).toEqual({ abandoned: 0, failed: 0 });
    expect(state.storageUploads.size).toBe(1);
    expect(bucketDeleted).toHaveLength(0);
    expect([...bucket.uploads.values()].every((upload) => !upload.aborted))
      .toBe(true);
  });

  it("retains a completed receipt after multipart cleanup until its File is removed", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "receipt-retention.bin",
      mimeType: "application/octet-stream",
      size: BigInt(4),
    });
    if (!started.ok) throw new Error(started.reason);
    await uploadPart({
      userId: USER_ID,
      uploadId: started.upload.id,
      partNumber: 1,
      contentLength: 4,
      body: streamOf(4),
    });
    const finished = await finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    });
    expect(finished.ok).toBe(true);
    const receipt = [...state.storageUploads.values()][0]!;
    const afterMultipartWindow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await expect(abandonStaleStorageUploads(afterMultipartWindow)).resolves.toEqual({
      abandoned: 0,
      failed: 0,
    });
    expect(state.storageUploads.has(receipt.id)).toBe(true);

    const afterLongRetention = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    await expect(abandonStaleStorageUploads(afterLongRetention)).resolves.toEqual({
      abandoned: 0,
      failed: 0,
    });
    expect(state.storageUploads.has(receipt.id)).toBe(true);
  });

  it("cannot be finished once the sweep has claimed it", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(4),
    });
    if (!started.ok) throw new Error(started.reason);
    await uploadPart({
      userId: USER_ID,
      uploadId: started.upload.id,
      partNumber: 1,
      contentLength: 4,
      body: streamOf(4),
    });
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await abandonStaleStorageUploads(tomorrow);

    // 掃除が終えたあとに完了要求が届いても、そのパートはもう無い。ここで File を
    // 作ると、消えたオブジェクトを指すことになる。
    const outcome = await finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    });

    expect(outcome).toEqual({ ok: false, reason: "uploadNotFound" });
    expect(state.files.size).toBe(0);
  });

  it("returns a concurrent completion instead of cleaning its object", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "concurrent-complete.bin",
      mimeType: "application/octet-stream",
      size: BigInt(4),
    });
    if (!started.ok) throw new Error(started.reason);
    const tracked = state.storageUploads.get(started.upload.id)!;
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => {
        throw Object.assign(new Error("NoSuchUpload"), {
          code: "NoSuchUpload",
        });
      },
      abort: vi.fn(),
    }));
    const concurrentFileId = "file-concurrent-completion";
    const recordUnknown = storageDb.recordStorageUploadCompletionUnknown;
    vi.spyOn(storageDb, "recordStorageUploadCompletionUnknown")
      .mockImplementationOnce(async (args) => {
        // The concurrent receipt wins the generation CAS first. The failure
        // recorder must then lose, and this caller must return that same File
        // instead of changing the completed row back to unknown.
        state.files.set(concurrentFileId, {
          id: concurrentFileId,
          objectKey: tracked.objectKey,
          name: tracked.name,
          size: 4,
          mimeType: tracked.mimeType,
          userId: USER_ID,
          visibility: "PRIVATE",
          sha256: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never);
        state.storageUploads.set(tracked.id, {
          ...state.storageUploads.get(tracked.id)!,
          completedFileId: concurrentFileId,
          completionState: "settled",
          completionLeaseUntil: null,
          completionLeaseToken: null,
          completionInterventionAt: null,
          completionRetryNotBefore: null,
        });
        return await recordUnknown(args);
      });

    const result = await finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    });

    expect(result).toMatchObject({
      ok: true,
      file: { id: concurrentFileId },
    });
    expect(bucketDeleted).toEqual([]);
    expect(state.storageUploads.get(tracked.id)?.completedFileId)
      .toBe(concurrentFileId);
  });

  it("fails closed when complete and HEAD outcomes are both unknown", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "complete-head-unknown.bin",
      mimeType: "application/octet-stream",
      size: BigInt(4),
    });
    if (!started.ok) throw new Error(started.reason);
    const tracked = state.storageUploads.get(started.upload.id)!;
    const abort = vi.fn();
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => {
        bucketObjects.set(tracked.objectKey, { key: tracked.objectKey });
        throw new Error("complete response lost after commit");
      },
      abort,
    }));
    bucket.head.mockRejectedValueOnce(new Error("temporary HEAD outage"));

    await expect(finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    })).resolves.toEqual({ ok: false, reason: "uploadFailed" });

    state.storageUploads.set(tracked.id, {
      ...state.storageUploads.get(tracked.id)!,
      completionLeaseUntil: new Date(Date.now() - 1),
    });

    expect(state.storageUploads.get(tracked.id)).toMatchObject({
      uploadId: tracked.uploadId,
      abandonedAt: null,
      completedFileId: null,
    });
    expect(state.aiStorageCleanups.has(tracked.objectKey)).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    expect(bucketDeleted).toEqual([]);

    bucket.head.mockResolvedValueOnce({ size: 4 } as never);
    await expect(finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    })).resolves.toMatchObject({ ok: true });
    expect(state.files.size).toBe(1);
  });

  it("keeps terminal completion absence unknown without scheduling cleanup", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "complete-terminal-absent.bin",
      mimeType: "application/octet-stream",
      size: BigInt(4),
    });
    if (!started.ok) throw new Error(started.reason);
    const tracked = state.storageUploads.get(started.upload.id)!;
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => {
        throw Object.assign(new Error("NoSuchUpload"), {
          code: "NoSuchUpload",
        });
      },
      abort: vi.fn(),
    }));

    await expect(finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    })).resolves.toEqual({ ok: false, reason: "uploadFailed" });

    expect(state.storageUploads.has(tracked.id)).toBe(true);
    expect(state.storageUploads.get(tracked.id)).toMatchObject({
      completionState: "unknown",
      completedFileId: null,
      abandonedAt: null,
    });
    expect(bucketDeleted).toEqual([]);
    expect(state.aiStorageCleanups.has(tracked.objectKey)).toBe(false);
    expect(bucketDeleted).toEqual([]);
    await expect(finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    })).resolves.toEqual({ ok: false, reason: "uploadFailed" });
    expect(bucket.resumeMultipartUpload).toHaveBeenCalledTimes(1);
  });

  it("does not clean up terminal absence after taking over an expired completion", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "takeover-terminal-absent.bin",
      mimeType: "application/octet-stream",
      size: BigInt(4),
    });
    if (!started.ok) throw new Error(started.reason);
    const row = state.storageUploads.get(started.upload.id)!;
    state.storageUploads.set(row.id, {
      ...row,
      completionState: "retry",
      completionLeaseUntil: new Date(Date.now() - 1),
      completionLeaseToken: "completion-owner-a",
    });
    const abort = vi.fn();
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => {
        throw Object.assign(new Error("NoSuchUpload"), { code: "NoSuchUpload" });
      },
      abort,
    }));

    await expect(finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    })).resolves.toEqual({ ok: false, reason: "uploadFailed" });

    expect(state.storageUploads.get(row.id)).toMatchObject({
      completionState: "retry",
      abandonedAt: null,
      completedFileId: null,
      cleanupLeaseToken: null,
    });
    expect(state.aiStorageCleanups.has(row.objectKey)).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    expect(bucketDeleted).toEqual([]);
  });

  it("does not take over when the first completion claim loses", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "claim-race-terminal-absent.bin",
      mimeType: "application/octet-stream",
      size: BigInt(4),
    });
    if (!started.ok) throw new Error(started.reason);
    const row = state.storageUploads.get(started.upload.id)!;
    const originalClaim = storageDb.claimStorageUploadCompletion;
    vi.spyOn(storageDb, "claimStorageUploadCompletion")
      .mockImplementationOnce(async () => {
        const current = state.storageUploads.get(row.id)!;
        state.storageUploads.set(row.id, {
          ...current,
          completionState: "completing",
          completionLeaseUntil: new Date(Date.now() - 1),
          completionLeaseToken: "completion-owner-a",
        });
        return false;
      })
      .mockImplementation((args) => originalClaim(args));
    const abort = vi.fn();
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => {
        throw Object.assign(new Error("NoSuchUpload"), { code: "NoSuchUpload" });
      },
      abort,
    }));

    await expect(finishUpload({
      userId: USER_ID,
      uploadId: started.upload.id,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    })).resolves.toEqual({ ok: false, reason: "uploadFailed" });

    expect(state.storageUploads.get(row.id)).toMatchObject({
      completionState: "completing",
      abandonedAt: null,
      completedFileId: null,
      cleanupLeaseToken: null,
    });
    expect(state.aiStorageCleanups.has(row.objectKey)).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    expect(bucket.resumeMultipartUpload).not.toHaveBeenCalled();
  });

  it("fences cleanup while completion is in flight", async () => {
    const started = await startUpload({
      userId: USER_ID, id: crypto.randomUUID(), name: "fence.bin",
      mimeType: "application/octet-stream", size: BigInt(4),
    });
    if (!started.ok) throw new Error(started.reason);
    const part = await uploadPart({
      userId: USER_ID, uploadId: started.upload.id, partNumber: 1,
      contentLength: 4, body: streamOf(4),
    });
    if (!part.ok) throw new Error(part.reason);
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const tracked = state.storageUploads.get(started.upload.id)!;
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => {
        entered();
        await releasePromise;
        bucketObjects.set(tracked.objectKey, { key: tracked.objectKey });
        return { size: 4 };
      },
      abort: vi.fn(),
    }));
    const a = finishUpload({ userId: USER_ID, uploadId: started.upload.id,
      parts: [{ partNumber: 1, etag: part.etag }] });
    await enteredPromise;
    const b = await finishUpload({ userId: USER_ID, uploadId: started.upload.id,
      parts: [{ partNumber: 1, etag: part.etag }] });
    expect(b).toEqual({ ok: false, reason: "uploadFailed" });
    await expect(storageDb.enqueueUserStorageCleanups({
      userId: USER_ID,
      now: new Date(),
    })).rejects.toBeInstanceOf(storageDb.StorageCleanupBusyError);
    expect(bucketDeleted).toEqual([]);
    expect(state.storageUploads.get(started.upload.id)?.completionState).toBe("completing");
    release();
    await expect(a).resolves.toMatchObject({ ok: true });
    expect(state.files.size).toBe(1);
  });

  it("does not finalize an old completion into a same-id replacement", async () => {
    const id = crypto.randomUUID();
    const started = await startUpload({
      userId: USER_ID,
      id,
      name: "old-generation.bin",
      mimeType: "application/octet-stream",
      size: BigInt(4),
    });
    if (!started.ok) throw new Error(started.reason);
    const old = state.storageUploads.get(id)!;
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => {
        state.storageUploads.delete(id);
        state.storageUploads.set(id, {
          ...old,
          objectKey: `${old.objectKey}-replacement`,
          uploadId: "multipart-replacement",
          name: "replacement.bin",
          createdAt: new Date(old.createdAt.getTime() + 1),
          completedFileId: null,
          abandonedAt: null,
          cleanupLeaseToken: null,
          cleanupLeaseUntil: null,
        });
        return { size: 4 };
      },
      abort: vi.fn(),
    }));

    await expect(finishUpload({
      userId: USER_ID,
      uploadId: id,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    })).resolves.toEqual({ ok: false, reason: "uploadNotFound" });

    expect(state.files.size).toBe(0);
    expect(state.storageUploads.get(id)).toMatchObject({
      objectKey: `${old.objectKey}-replacement`,
      uploadId: "multipart-replacement",
      completedFileId: null,
    });
  });

  it("does not return a replacement generation's completion receipt", async () => {
    const id = crypto.randomUUID();
    const started = await startUpload({
      userId: USER_ID,
      id,
      name: "lost-old-receipt.bin",
      mimeType: "application/octet-stream",
      size: BigInt(4),
    });
    if (!started.ok) throw new Error(started.reason);
    const old = state.storageUploads.get(id)!;
    const replacementFileId = "replacement-file";
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => {
        state.files.set(replacementFileId, {
          id: replacementFileId,
          objectKey: `${old.objectKey}-replacement`,
          name: "replacement.bin",
          size: 4,
          mimeType: old.mimeType,
          userId: USER_ID,
          visibility: "PRIVATE",
          sha256: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never);
        state.storageUploads.set(id, {
          ...old,
          objectKey: `${old.objectKey}-replacement`,
          uploadId: "multipart-replacement",
          createdAt: new Date(old.createdAt.getTime() + 1),
          completedFileId: replacementFileId,
        });
        throw Object.assign(new Error("NoSuchUpload"), {
          code: "NoSuchUpload",
        });
      },
      abort: vi.fn(),
    }));

    const result = await finishUpload({
      userId: USER_ID,
      uploadId: id,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    });

    expect(result).not.toMatchObject({
      ok: true,
      file: { id: replacementFileId },
    });
    expect(state.storageUploads.get(id)?.completedFileId)
      .toBe(replacementFileId);
    expect(bucketDeleted).toEqual([]);
  });

  it("tries the abort again when a cancel finds the row already claimed", async () => {
    // 前の取り消しがここまで来て中止に失敗していると、行は掃除のものになって
    // いる。そこで「もう済んでいる」と答えると、パートはバケットに残ったまま
    // 一日ぶんの枠を抱える。
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    const [tracked] = [...state.storageUploads.values()];
    state.storageUploads.set(tracked!.id, {
      ...tracked!,
      abandonedAt: new Date(),
    });

    expect(await cancelUpload({ userId: USER_ID, uploadId: started.upload.id }))
      .toBe("cancelled");

    expect([...bucket.uploads.values()].every((upload) => upload.aborted))
      .toBe(true);
    expect(state.storageUploads.size).toBe(0);
  });

  it("says the parts are still there when the bucket will not let go", async () => {
    // 片付いたと答えると、送った側はそこで手を引き、その分の枠が一日残る。
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => ({ size: 0 }),
      abort: async () => {
        throw new Error("the bucket is unreachable");
      },
    }));

    expect(await cancelUpload({ userId: USER_ID, uploadId: started.upload.id }))
      .toBe("pending");
    // 行は残る。掃除がもう一度試せる唯一の手掛かりなので。
    expect(state.storageUploads.size).toBe(1);
  });

  it("reloads after an intent gains its handle during cancellation", async () => {
    const id = crypto.randomUUID();
    const objectKey = `storage-upload/${USER_ID}/${id}`;
    await storageDb.createStorageUploadIntent({
      userId: USER_ID,
      id,
      objectKey,
      name: "cancel-attach-race.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
      partSize: STORAGE_UPLOAD_PART_BYTES,
    });
    const now = new Date();
    expect(await storageDb.claimStorageUploadCreation({
      id,
      userId: USER_ID,
      now,
      leaseUntil: new Date(now.getTime() + 60_000),
      leaseToken: "creator",
    })).toBe(true);
    const multipart = await bucket.createMultipartUpload(objectKey);
    const originalClaim = storageDb.claimStorageUploadForAbandon;
    vi.spyOn(storageDb, "claimStorageUploadForAbandon")
      .mockImplementationOnce(async (args) => {
        expect(await storageDb.attachStorageUploadRemote({
          id,
          userId: USER_ID,
          uploadId: multipart.uploadId,
          leaseToken: "creator",
        })).toBe(true);
        return await originalClaim(args);
      });

    expect(await cancelUpload({ userId: USER_ID, uploadId: id }))
      .toBe("pending");
    expect(state.storageUploads.get(id)).toMatchObject({
      uploadId: multipart.uploadId,
      abandonedAt: null,
    });

    expect(await cancelUpload({ userId: USER_ID, uploadId: id }))
      .toBe("cancelled");
    expect(bucket.uploads.get(multipart.uploadId)?.aborted).toBe(true);
    expect(state.storageUploads.has(id)).toBe(false);
  });

  it("delays joined object cleanup before cancel drops a terminal row", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "cancel-terminal.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    const [tracked] = [...state.storageUploads.values()];
    bucketObjects.set(tracked!.objectKey, { key: tracked!.objectKey });
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => ({ size: 0 }),
      abort: async () => {
        throw Object.assign(new Error("NoSuchUpload"), { code: "NoSuchUpload" });
      },
    }));

    await expect(cancelUpload({ userId: USER_ID, uploadId: started.upload.id }))
      .resolves.toBe("cancelled");
    expect(bucketDeleted).toEqual([]);
    expect(state.storageUploads.size).toBe(0);
    const cleanup = state.aiStorageCleanups.get(tracked!.objectKey)!;
    await expect(reconcileAiStorageCleanups(cleanup.notBefore)).resolves.toEqual({
      inspected: 1,
      deleted: 1,
      errors: 0,
    });
    expect(bucketDeleted).toEqual([tracked!.objectKey]);
  });

  it("keeps terminal cancel object cleanup retryable after delete failure", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "cancel-terminal-retry.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    const [tracked] = [...state.storageUploads.values()];
    bucketObjects.set(tracked!.objectKey, { key: tracked!.objectKey });
    bucketDeleteFails = true;
    bucket.resumeMultipartUpload.mockImplementationOnce(() => ({
      uploadPart: async () => ({ partNumber: 1, etag: "etag-1" }),
      complete: async () => ({ size: 0 }),
      abort: async () => {
        throw Object.assign(new Error("NoSuchUpload"), { code: "NoSuchUpload" });
      },
    }));

    await expect(cancelUpload({ userId: USER_ID, uploadId: started.upload.id }))
      .resolves.toBe("cancelled");
    expect(state.storageUploads.size).toBe(0);
    const cleanup = state.aiStorageCleanups.get(tracked!.objectKey)!;
    await expect(reconcileAiStorageCleanups(cleanup.notBefore)).resolves.toEqual({
      inspected: 1,
      deleted: 0,
      errors: 1,
    });
    expect(state.aiStorageCleanups.has(tracked!.objectKey)).toBe(true);
  });

  it("sweeps a claimed upload without waiting out the day", async () => {
    // 掃除のものになった行は、誰かが既に「捨てる」と決めて捨てられなかったもの。
    // 手つかずのアップロードと同じ一日を待たせると、そのぶんの保管料と枠が理由
    // なく残る。
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    const [tracked] = [...state.storageUploads.values()];
    state.storageUploads.set(tracked!.id, {
      ...tracked!,
      abandonedAt: new Date(),
    });

    const swept = await abandonStaleStorageUploads(new Date());

    expect(swept).toEqual({ abandoned: 1, failed: 0 });
    expect(state.storageUploads.size).toBe(0);
  });

  it("records a cancellation for an upload that has not appeared yet", async () => {
    // 開始の応答が返らなかった側が取り消しに回ってくる。まだ行が現れていない
    // だけかもしれないので、先回りして墓標を置く——そのあとに始めようとしたもの
    // は、この行にぶつかって始まらない。
    const id = crypto.randomUUID();

    expect(await cancelUpload({ userId: USER_ID, uploadId: id }))
      .toBe("cancelled");

    const refused = await startUpload({
      userId: USER_ID,
      id,
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });

    expect(refused).toEqual({ ok: false, reason: "uploadFailed" });
    // すぐには消さない。遅れて現れる開始を止めるために置いたものなので、その
    // 開始より先に消えては意味がない。
    expect(await abandonStaleStorageUploads(new Date()))
      .toEqual({ abandoned: 0, failed: 0 });
    expect(state.storageUploads.size).toBe(1);

    const later = new Date(Date.now() + 16 * 60 * 1000);
    expect(await abandonStaleStorageUploads(later))
      .toEqual({ abandoned: 1, failed: 0 });
    expect(state.storageUploads.size).toBe(0);
  });

  it("stops placing marks for uploads that never appear", async () => {
    // 墓標はどんな名前にも置けるので、数だけが際限なく増える。抱えているものが
    // 無いぶん枠にも本数にも数えられないから、ここで限る。
    for (let index = 0; index < 20; index++) {
      await cancelUpload({ userId: USER_ID, uploadId: crypto.randomUUID() });
    }

    expect(state.storageUploads.size).toBe(16);
    expect(await cancelUpload({ userId: USER_ID, uploadId: crypto.randomUUID() }))
      .toBe("missing");
  });

  it("stops placing marks even when the cancellations arrive together", async () => {
    // 数えるのと書くのが別々だと、同時に届いた取り消しがどれも「まだ上限より下」
    // を読み、いくらでも置けてしまう。一続きにしてあれば、同時に来ても上限で
    // 止まる。
    await Promise.all(
      Array.from({ length: 32 }, () =>
        cancelUpload({ userId: USER_ID, uploadId: crypto.randomUUID() })),
    );

    expect(state.storageUploads.size).toBe(16);
  });

  it("keeps the size of a claimed upload against the quota", async () => {
    // 掃除が「捨てる」と宣言しても、中止に失敗しているあいだ、そのパートは
    // 本当にバケットにある。枠から外すと、実際の使用量が枠の外に出る。
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(STORAGE_QUOTA_BYTES),
    });
    if (!started.ok) throw new Error(started.reason);
    const [tracked] = [...state.storageUploads.values()];
    state.storageUploads.set(tracked!.id, {
      ...tracked!,
      abandonedAt: new Date(),
    });

    const next = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "another.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });

    expect(next).toEqual({ ok: false, reason: "insufficientStorageSpace" });
  });

  it("does not create a remote multipart before quota admission", async () => {
    // Quota rejection happens from the durable start-intent transaction. No
    // remote handle exists, so there is nothing to abort or record.
    const first = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(STORAGE_QUOTA_BYTES),
    });
    if (!first.ok) throw new Error(first.reason);
    const refused = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "another.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });

    expect(refused).toEqual({ ok: false, reason: "insufficientStorageSpace" });
    expect(bucket.createMultipartUpload).toHaveBeenCalledTimes(1);
    expect([...state.storageUploads.values()]).toHaveLength(1);
  });

  it("refuses to start once the account holds as many files as it may", async () => {
    // 容量だけでは本数を縛れない。1 バイトのファイルを順に完成させれば、枠の
    // 内側で R2 のオブジェクトと行をいくらでも増やせる。
    for (let index = 0; index < STORAGE_FILE_COUNT_LIMIT; index++) {
      state.files.set(`file-${index}`, {
        id: `file-${index}`,
        objectKey: `key-${index}`,
        name: `file-${index}.bin`,
        size: 1,
        mimeType: "application/octet-stream",
        userId: USER_ID,
        visibility: "PRIVATE",
        sha256: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);
    }

    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(4),
    });

    expect(started).toEqual({ ok: false, reason: "tooManyFiles" });
    // 誰も知らないマルチパートを残さない。
    expect([...bucket.uploads.values()].every((upload) => upload.aborted))
      .toBe(true);
    expect(state.storageUploads.size).toBe(0);
  });

  it("leaves an upload that has only just started alone", async () => {
    await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: BigInt(1_000),
    });

    expect(await abandonStaleStorageUploads(new Date())).toEqual({
      abandoned: 0,
      failed: 0,
    });
    expect(state.storageUploads.size).toBe(1);
  });

  it("does not contact R2 when the durable start transaction is unavailable", async () => {
    setDbProvider(async () => {
      throw new Error("database unavailable");
    });

    await expect(startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "blocked.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    })).rejects.toThrow("database unavailable");
    expect(bucket.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("recovers attach commit-then-throw as an active start", async () => {
    const attach = storageDb.attachStorageUploadRemote;
    vi.spyOn(storageDb, "attachStorageUploadRemote")
      .mockImplementation(async (args) => {
        const committed = await attach(args);
        if (committed) throw new Error("attach response lost after commit");
        return false;
      });

    const result = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "attach-commit.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    });

    expect(result.ok).toBe(true);
    expect([...state.storageUploads.values()][0]?.uploadId).toBeTruthy();
    expect(state.storageMultipartCleanups.size).toBe(0);
    expect(bucket.resumeMultipartUpload).not.toHaveBeenCalled();
  });

  it("recovers fallback record commit-then-throw as an active start", async () => {
    const record = storageDb.recordStorageUploadRemoteAfterAttachFailure;
    vi.spyOn(storageDb, "attachStorageUploadRemote").mockResolvedValue(false);
    vi.spyOn(storageDb, "recordStorageUploadRemoteAfterAttachFailure")
      .mockImplementation(async (args) => {
        const committed = await record(args);
        if (committed) throw new Error("record response lost after commit");
        return false;
      });

    const result = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "record-commit.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    });

    expect(result.ok).toBe(true);
    expect([...state.storageUploads.values()][0]?.uploadId).toBeTruthy();
    expect(state.storageMultipartCleanups.size).toBe(0);
    expect(bucket.resumeMultipartUpload).not.toHaveBeenCalled();
  });

  it("does not enqueue or abort when a committed attach cannot be reloaded", async () => {
    const attach = storageDb.attachStorageUploadRemote;
    const find = storageDb.findStorageUploadByIdAndUserId;
    const findSpy = vi.spyOn(storageDb, "findStorageUploadByIdAndUserId")
      .mockImplementation(find);
    vi.spyOn(storageDb, "attachStorageUploadRemote")
      .mockImplementation(async (args) => {
        const committed = await attach(args);
        if (committed) {
          findSpy.mockRejectedValue(new Error("database read unavailable"));
          throw new Error("attach response lost after commit");
        }
        return false;
      });

    await expect(startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "unknown-commit.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    })).rejects.toThrow("outcome could not be verified");

    expect([...state.storageUploads.values()][0]?.uploadId).toBeTruthy();
    expect(state.storageMultipartCleanups.size).toBe(0);
    expect(bucket.resumeMultipartUpload).not.toHaveBeenCalled();
  });

  it("detaches a handle recorded after account deletion froze its row", async () => {
    const record = storageDb.recordStorageUploadRemoteAfterAttachFailure;
    vi.spyOn(storageDb, "attachStorageUploadRemote").mockResolvedValue(false);
    vi.spyOn(storageDb, "recordStorageUploadRemoteAfterAttachFailure")
      .mockImplementation(async (args) => {
        const committed = await record(args);
        const row = state.storageUploads.get(args.id);
        if (row) {
          state.storageUploads.set(args.id, {
            ...row,
            abandonedAt: new Date(),
          });
        }
        if (committed) throw new Error("record response lost after commit");
        return false;
      });

    await expect(startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "deleted-account.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    })).rejects.toThrow("recorded for cleanup");

    const [row] = [...state.storageUploads.values()];
    expect(row?.uploadId).toBeTruthy();
    expect(row?.abandonedAt).not.toBeNull();
    expect([...state.storageMultipartCleanups.values()]).toEqual([
      expect.objectContaining({
        objectKey: row!.objectKey,
        uploadId: row!.uploadId,
      }),
    ]);
  });

  it("detaches a late handle after account deletion cascades its null-id row", async () => {
    vi.spyOn(storageDb, "attachStorageUploadRemote")
      .mockImplementation(async ({ id }) => {
        state.storageUploads.delete(id);
        return false;
      });

    await expect(startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "late-after-cascade.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    })).rejects.toThrow("recorded for cleanup");

    expect(state.storageUploads.size).toBe(0);
    expect(state.storageMultipartCleanups.size).toBe(1);
  });

  it("does not write an old creator's handle into a same-id replacement", async () => {
    const id = crypto.randomUUID();
    let oldObjectKey = "";
    let replaced = false;
    vi.spyOn(storageDb, "attachStorageUploadRemote")
      .mockImplementation(async () => {
        if (!replaced) {
          const old = state.storageUploads.get(id)!;
          oldObjectKey = old.objectKey;
          state.storageUploads.set(id, {
            ...old,
            objectKey: `${old.objectKey}-replacement`,
            name: "replacement.bin",
            createdAt: new Date(old.createdAt.getTime() + 1),
            uploadId: null,
            startState: "creating",
            creationLeaseToken: "replacement-creator",
            creationLeaseUntil: new Date(Date.now() + 60_000),
          });
          replaced = true;
        }
        return false;
      });

    await expect(startUpload({
      userId: USER_ID,
      id,
      name: "old-creator.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    })).rejects.toThrow("recorded for cleanup");

    expect(state.storageUploads.get(id)).toMatchObject({
      objectKey: `${oldObjectKey}-replacement`,
      uploadId: null,
      name: "replacement.bin",
      creationLeaseToken: "replacement-creator",
    });
    expect([...state.storageMultipartCleanups.values()]).toEqual([
      expect.objectContaining({
        objectKey: oldObjectKey,
        uploadId: expect.stringMatching(/^upload-/),
      }),
    ]);
  });

  it("converges duplicate starts on one remote multipart", async () => {
    const id = crypto.randomUUID();
    const outcomes = await Promise.all([
      startUpload({ userId: USER_ID, id, name: "same.bin", mimeType: "application/octet-stream", size: BigInt(1_000) }),
      startUpload({ userId: USER_ID, id, name: "loser.mp4", mimeType: "video/mp4", size: BigInt(1_000) }),
    ]);
    expect(bucket.createMultipartUpload).toHaveBeenCalledTimes(1);
    expect([...state.storageUploads.values()]).toHaveLength(1);
    const winner = [...state.storageUploads.values()][0]!;
    expect(winner.uploadId).toBeTruthy();
    expect(bucket.createMultipartUpload.mock.calls[0]?.[0]).toBe(
      winner.objectKey,
    );
    expect(bucket.createMultipartUpload.mock.calls[0]?.[1]).toEqual({
      httpMetadata: { contentType: winner.mimeType },
    });
    expect(outcomes.some((outcome) => outcome.ok)).toBe(true);
  });

  it("expires an intent without calling a nonexistent multipart", async () => {
    const started = await startUpload({
      userId: USER_ID,
      id: crypto.randomUUID(),
      name: "intent.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1_000),
    });
    if (!started.ok) throw new Error(started.reason);
    const row = [...state.storageUploads.values()][0]!;
    state.storageUploads.set(row.id, {
      ...row,
      uploadId: null,
      startState: "intent",
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    await expect(abandonStaleStorageUploads(new Date())).resolves.toMatchObject({ abandoned: 1 });
    expect(state.storageUploads.size).toBe(0);
    expect([...bucket.uploads.values()].every((upload) => !upload.aborted)).toBe(true);
  });
});
