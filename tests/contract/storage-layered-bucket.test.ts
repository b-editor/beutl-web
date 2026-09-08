import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLayeredBucket, type R2BucketLike } from "@beutl/api";

function fakeBucket() {
  const handle = {
    uploadPart: vi.fn(async (partNumber: number) => ({ partNumber, etag: "e" })),
    complete: vi.fn(async () => ({ size: 1 })),
    abort: vi.fn(async () => undefined),
  };
  const bucket = {
    put: vi.fn(async () => ({ stored: true })),
    get: vi.fn(async () => null as { size?: number } | null),
    head: vi.fn(async () => null as { size?: number } | null),
    delete: vi.fn(async () => undefined),
    createMultipartUpload: vi.fn(async () => ({ uploadId: "id" })),
    resumeMultipartUpload: vi.fn(() => handle),
  };
  return { bucket, handle };
}

const missing = () => Object.assign(new Error("R2 multipart error (10024)"), { code: "NoSuchUpload" });

describe("a bucket layered over the store objects used to live in", () => {
  let primary: ReturnType<typeof fakeBucket>;
  let fallback: ReturnType<typeof fakeBucket>;
  let layered: R2BucketLike;

  beforeEach(() => {
    primary = fakeBucket();
    fallback = fakeBucket();
    layered = createLayeredBucket({
      primary: primary.bucket as unknown as R2BucketLike,
      fallback: fallback.bucket as unknown as R2BucketLike,
    });
  });

  it("writes only to the primary", async () => {
    const value = new Uint8Array([1]).buffer;
    await layered.put("k", value, { httpMetadata: { contentType: "text/plain" } });
    await layered.createMultipartUpload!("k", { httpMetadata: { contentType: "video/mp4" } });
    expect(primary.bucket.put).toHaveBeenCalledWith("k", value, { httpMetadata: { contentType: "text/plain" } });
    expect(primary.bucket.createMultipartUpload).toHaveBeenCalledWith("k", { httpMetadata: { contentType: "video/mp4" } });
    expect(fallback.bucket.put).not.toHaveBeenCalled();
    expect(fallback.bucket.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("reads from the fallback only when the primary has no such object", async () => {
    primary.bucket.get.mockResolvedValueOnce({ size: 3 });
    expect(await layered.get!("new")).toEqual({ size: 3 });
    expect(fallback.bucket.get).not.toHaveBeenCalled();

    fallback.bucket.get.mockResolvedValueOnce({ size: 7 });
    expect(await layered.get!("old")).toEqual({ size: 7 });
    expect(fallback.bucket.get).toHaveBeenCalledWith("old");

    expect(await layered.get!("gone")).toBeNull();
  });

  it("measures through the same order as it reads", async () => {
    fallback.bucket.head.mockResolvedValueOnce({ size: 9 });
    expect(await layered.head!("old")).toEqual({ size: 9 });
    expect(primary.bucket.head).toHaveBeenCalledWith("old");
    expect(await layered.head!("gone")).toBeNull();
  });

  it("does not hide a failing primary behind the fallback", async () => {
    primary.bucket.get.mockRejectedValueOnce(new Error("primary down"));
    fallback.bucket.get.mockResolvedValueOnce({ size: 1 });
    await expect(layered.get!("k")).rejects.toThrow("primary down");
    expect(fallback.bucket.get).not.toHaveBeenCalled();
  });

  it("deletes from both stores even when one of them fails", async () => {
    await layered.delete!("k");
    expect(primary.bucket.delete).toHaveBeenCalledWith("k");
    expect(fallback.bucket.delete).toHaveBeenCalledWith("k");

    fallback.bucket.delete.mockRejectedValueOnce(new Error("fallback down"));
    await expect(layered.delete!("k")).rejects.toThrow("fallback down");

    primary.bucket.delete.mockRejectedValueOnce(new Error("primary down"));
    await expect(layered.delete!("k")).rejects.toThrow("primary down");
    expect(fallback.bucket.delete).toHaveBeenCalledTimes(3);
  });

  it("finishes or abandons a handle the primary never opened", async () => {
    primary.handle.complete.mockRejectedValueOnce(missing());
    fallback.handle.complete.mockResolvedValueOnce({ size: 42 });
    const handle = layered.resumeMultipartUpload!("k", "old-upload");
    expect(await handle.complete([{ partNumber: 1, etag: "e" }])).toEqual({ size: 42 });
    expect(fallback.handle.complete).toHaveBeenCalledWith([{ partNumber: 1, etag: "e" }]);

    primary.handle.abort.mockRejectedValueOnce(missing());
    await expect(handle.abort()).resolves.toBeUndefined();
    expect(fallback.handle.abort).toHaveBeenCalled();
  });

  it("aborts in both stores even when the primary claims success", async () => {
    // MinIO answers 204 for an id it never issued; the stale R2 handle must
    // still be aborted.
    const handle = layered.resumeMultipartUpload!("k", "old-upload");
    await expect(handle.abort()).resolves.toBeUndefined();
    expect(primary.handle.abort).toHaveBeenCalledTimes(1);
    expect(fallback.handle.abort).toHaveBeenCalledTimes(1);

    fallback.handle.abort.mockRejectedValueOnce(new Error("fallback down"));
    await expect(handle.abort()).rejects.toThrow("fallback down");
  });

  it("reports the primary's terminal error when neither store knows the handle", async () => {
    const original = missing();
    primary.handle.abort.mockRejectedValueOnce(original);
    fallback.handle.abort.mockRejectedValueOnce(missing());
    await expect(layered.resumeMultipartUpload!("k", "id").abort()).rejects.toBe(original);
  });

  it("passes other multipart failures through untouched", async () => {
    primary.handle.complete.mockRejectedValueOnce(new Error("EntityTooSmall"));
    await expect(layered.resumeMultipartUpload!("k", "id").complete([])).rejects.toThrow("EntityTooSmall");
    expect(fallback.handle.complete).not.toHaveBeenCalled();
  });

  it("never replays a part against the fallback", async () => {
    primary.handle.uploadPart.mockRejectedValueOnce(missing());
    const stream = new ReadableStream<Uint8Array>();
    await expect(layered.resumeMultipartUpload!("k", "id").uploadPart(1, stream, { contentLength: 0 }))
      .rejects.toMatchObject({ code: "NoSuchUpload" });
    expect(primary.handle.uploadPart).toHaveBeenCalledWith(1, stream, { contentLength: 0 });
    expect(fallback.handle.uploadPart).not.toHaveBeenCalled();
  });

  it("offers only what the primary can do", () => {
    const readOnly = createLayeredBucket({
      primary: { put: primary.bucket.put, get: primary.bucket.get } as unknown as R2BucketLike,
      fallback: fallback.bucket as unknown as R2BucketLike,
    });
    expect(readOnly.delete).toBeUndefined();
    expect(readOnly.head).toBeUndefined();
    expect(readOnly.resumeMultipartUpload).toBeUndefined();
  });
});
