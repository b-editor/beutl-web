// 実物の S3 互換サービスに対する疎通確認。BEUTL_S3_TEST_ENDPOINT などが無いときは
// 走らない。ローカルの MinIO なら次のように設定する:
//   BEUTL_S3_TEST_ENDPOINT=http://127.0.0.1:9000 BEUTL_S3_TEST_BUCKET=beutl-test
//   BEUTL_S3_TEST_ACCESS_KEY_ID=minioadmin BEUTL_S3_TEST_SECRET_ACCESS_KEY=minioadmin
import { describe, expect, it } from "vitest";
import {
  createS3CompatibleBucket,
  isTerminalMultipartAbortError,
  S3StorageError,
} from "@beutl/api";

const endpoint = process.env.BEUTL_S3_TEST_ENDPOINT;
const bucketName = process.env.BEUTL_S3_TEST_BUCKET;
const accessKeyId = process.env.BEUTL_S3_TEST_ACCESS_KEY_ID;
const secretAccessKey = process.env.BEUTL_S3_TEST_SECRET_ACCESS_KEY;
const configured = Boolean(endpoint && bucketName && accessKeyId && secretAccessKey);

function liveBucket() {
  return createS3CompatibleBucket({
    endpoint: endpoint!,
    bucket: bucketName!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    region: process.env.BEUTL_S3_TEST_REGION,
    forcePathStyle: process.env.BEUTL_S3_TEST_FORCE_PATH_STYLE !== "false",
    allowInsecureHttp: true,
  });
}

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function same(actual: Uint8Array, expected: Uint8Array): boolean {
  return Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength)
    .equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength));
}

describe.skipIf(!configured)("S3 compatible bucket against a live service", { timeout: 60_000 }, () => {
  it("round-trips a single object", async () => {
    const bucket = liveBucket();
    const key = `live/${crypto.randomUUID()}/name with spaces & symbols.bin`;
    const payload = bytes(1024, 7);
    await bucket.put(key, payload.buffer as ArrayBuffer, {
      httpMetadata: { contentType: "application/octet-stream" },
    });

    expect(await bucket.head!(key)).toEqual({ size: 1024 });
    const read = await bucket.get!(key);
    expect(read?.size).toBe(1024);
    expect(same(await drain(read!.body!), payload)).toBe(true);

    await bucket.delete!(key);
    expect(await bucket.head!(key)).toBeNull();
    expect(await bucket.get!(key)).toBeNull();
    await expect(bucket.delete!(key)).resolves.toBeUndefined();
  });

  it("joins streamed parts and measures the result", async () => {
    const bucket = liveBucket();
    const key = `live/${crypto.randomUUID()}/multipart.bin`;
    // S3 requires every part but the last to be at least 5 MiB.
    const first = bytes(5 * 1024 * 1024, 1);
    const second = bytes(1024, 2);
    const { uploadId } = await bucket.createMultipartUpload!(key, {
      httpMetadata: { contentType: "video/mp4" },
    });
    const handle = bucket.resumeMultipartUpload!(key, uploadId);
    const parts = [
      await handle.uploadPart(1, streamOf(first.subarray(0, 1 << 20), first.subarray(1 << 20)), { contentLength: first.byteLength }),
      await handle.uploadPart(2, streamOf(second), { contentLength: second.byteLength }),
    ];
    expect(parts.map((part) => part.partNumber)).toEqual([1, 2]);
    for (const part of parts) expect(part.etag).not.toMatch(/^"/u);

    const joined = await handle.complete(parts);
    expect(joined.size).toBe(first.byteLength + second.byteLength);
    const read = await bucket.get!(key);
    const stored = await drain(read!.body!);
    expect(stored.byteLength).toBe(first.byteLength + second.byteLength);
    expect(same(stored.subarray(0, first.byteLength), first)).toBe(true);
    expect(same(stored.subarray(first.byteLength), second)).toBe(true);
    await bucket.delete!(key);

    // The joined upload id is gone. AWS S3 and R2 answer NoSuchUpload, which
    // the reconcilers treat as terminal; MinIO answers 204 instead. Either way
    // the part must no longer be accepted.
    let error: unknown;
    try {
      await handle.abort();
    } catch (caught) {
      error = caught;
    }
    if (error !== undefined) {
      expect(error).toBeInstanceOf(S3StorageError);
      expect(isTerminalMultipartAbortError(error)).toBe(true);
    }
    await expect(handle.uploadPart(1, streamOf(bytes(8, 4)), { contentLength: 8 }))
      .rejects.toMatchObject({ code: "NoSuchUpload" });
  });

  it("aborts an upload that was never completed", async () => {
    const bucket = liveBucket();
    const key = `live/${crypto.randomUUID()}/abandoned.bin`;
    const { uploadId } = await bucket.createMultipartUpload!(key);
    const handle = bucket.resumeMultipartUpload!(key, uploadId);
    await handle.uploadPart(1, streamOf(bytes(16, 3)), { contentLength: 16 });
    await expect(handle.abort()).resolves.toBeUndefined();
    expect(await bucket.head!(key)).toBeNull();
  });
});
