import { createHash } from "node:crypto";
import type { GitDurableStorage, LfsRecord } from "./lfs";
import type { GitR2Bucket } from "./r2-object-store";

export const MULTIPART_PART_BYTES = 64 * 1024 * 1024;
export const MAX_MULTIPART_PARTS = 10_000;
export const MAX_MULTIPART_OBJECT_BYTES = MULTIPART_PART_BYTES * MAX_MULTIPART_PARTS;
export const MULTIPART_RESERVATION_MS = 24 * 60 * 60 * 1000;

const response = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Content-Type": "application/vnd.git-lfs+json", "Cache-Control": "no-store" },
});
const recordKey = (oid: string) => `lfs:${oid}`;
const partPrefix = (oid: string) => `part:${oid}:`;
const partKey = (oid: string, number: number) => `${partPrefix(oid)}${String(number).padStart(5, "0")}`;
const objectKey = (repoId: string, oid: string) => `git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`;
type Part = { partNumber: number; etag: string; size: number };

async function partsFor(storage: GitDurableStorage, oid: string): Promise<Part[]> {
  const parts = await storage.list<Part>({ prefix: partPrefix(oid) });
  return [...parts.values()].sort((a, b) => a.partNumber - b.partNumber);
}

async function clearParts(storage: GitDurableStorage, oid: string): Promise<void> {
  const parts = await storage.list<Part>({ prefix: partPrefix(oid) });
  for (const key of parts.keys()) await storage.delete(key);
}

export async function abortMultipart(
  bucket: GitR2Bucket, storage: GitDurableStorage, repoId: string, oid: string, record: LfsRecord,
): Promise<void> {
  if (record.uploadId && !record.completed) {
    try {
      await bucket.resumeMultipartUpload(objectKey(repoId, oid), record.uploadId).abort();
    } catch (error) {
      // The upload can already have expired in R2. Its final object still
      // cannot be served without a verified Durable Object record.
      console.warn("Git LFS multipart abort failed", { repoId, oid, error });
    }
  }
  await bucket.delete(objectKey(repoId, oid));
  await clearParts(storage, oid);
  await storage.delete(recordKey(oid));
}

async function verifyCompletedObject(bucket: GitR2Bucket, repoId: string, oid: string, expectedSize: number, signal: AbortSignal): Promise<boolean> {
  const object = await bucket.get(objectKey(repoId, oid));
  if (!object || object.size !== expectedSize) return false;
  const hash = createHash("sha256");
  const reader = object.body.getReader();
  let size = 0;
  let consumed = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) { consumed = true; break; }
      size += chunk.value.byteLength;
      if (size > expectedSize) return false;
      hash.update(chunk.value);
    }
  } finally {
    if (!consumed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return size === expectedSize && hash.digest("hex") === oid;
}

export async function handleMultipart(
  request: Request, bucket: GitR2Bucket, storage: GitDurableStorage,
  repoId: string, oid: string, operation: string,
): Promise<Response> {
  request.signal.throwIfAborted();
  const record = await storage.get<LfsRecord>(recordKey(oid));
  if (!record || record.kind !== "multipart" || record.expiresAt <= Date.now() && !record.verified) {
    return response({ message: "Multipart reservation expired; request a new LFS batch" }, 404);
  }
  const key = objectKey(repoId, oid);
  if (request.method === "DELETE" && operation === "") {
    if (record.verified) return response({ message: "Object is already verified" }, 409);
    await abortMultipart(bucket, storage, repoId, oid, record);
    return new Response(null, { status: 204 });
  }
  if (request.method === "POST" && operation === "") {
    if (record.verified) return response({ complete: true, partSize: MULTIPART_PART_BYTES, parts: [] });
    if (!record.uploadId) {
      const upload = await bucket.createMultipartUpload(key);
      record.uploadId = upload.uploadId;
      await storage.put(recordKey(oid), record);
    }
    return response({
      complete: false,
      partSize: MULTIPART_PART_BYTES,
      partCount: Math.ceil(record.size / MULTIPART_PART_BYTES),
      parts: await partsFor(storage, oid),
    });
  }
  if (request.method === "PUT" && /^parts\/\d+$/u.test(operation)) {
    if (!record.uploadId || record.completed) return response({ message: "Multipart upload is not active" }, 409);
    const partNumber = Number(operation.slice(6));
    const partCount = Math.ceil(record.size / MULTIPART_PART_BYTES);
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > partCount || partCount > MAX_MULTIPART_PARTS) {
      return response({ message: "Invalid part number" }, 400);
    }
    const expected = partNumber === partCount
      ? record.size - MULTIPART_PART_BYTES * (partCount - 1)
      : MULTIPART_PART_BYTES;
    if (request.headers.get("x-beutl-git-part-length") !== String(expected) || !request.body) {
      return response({ message: "Part length mismatch" }, 400);
    }
    let received = 0;
    const measured = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        request.signal.throwIfAborted();
        received += chunk.byteLength;
        if (received > expected) throw new RangeError("Multipart part exceeds its declared length");
        controller.enqueue(chunk);
      },
      flush() {
        if (received !== expected) throw new RangeError("Multipart part is incomplete");
      },
    }));
    const result = await bucket.resumeMultipartUpload(key, record.uploadId).uploadPart(partNumber, measured);
    if (received !== expected) return response({ message: "Part length mismatch" }, 422);
    const part = { partNumber, etag: result.etag, size: expected };
    await storage.put(partKey(oid, partNumber), part);
    return response(part);
  }
  if (request.method === "POST" && operation === "complete") {
    if (record.verified) return response({ oid, size: record.size });
    if (!record.uploadId) return response({ message: "Multipart upload has not started" }, 409);
    if (!record.completed) {
      // Completion can succeed in R2 and then lose its response or the DO
      // write. Re-read the private key before retrying CompleteMultipartUpload.
      const existing = await bucket.head(key);
      if (!existing) {
        const parts = await partsFor(storage, oid);
        const partCount = Math.ceil(record.size / MULTIPART_PART_BYTES);
        if (partCount > MAX_MULTIPART_PARTS || parts.length !== partCount ||
            parts.some((part, index) => part.partNumber !== index + 1 ||
              part.size !== (index === partCount - 1 ? record.size - MULTIPART_PART_BYTES * index : MULTIPART_PART_BYTES))) {
          return response({ message: "Multipart upload has missing parts" }, 409);
        }
        const object = await bucket.resumeMultipartUpload(key, record.uploadId).complete(
          parts.map(({ partNumber, etag }) => ({ partNumber, etag })),
        );
        if (object.size !== record.size) {
          await abortMultipart(bucket, storage, repoId, oid, record);
          return response({ message: "Completed object size mismatch" }, 422);
        }
      } else if (existing.size !== record.size) {
        await abortMultipart(bucket, storage, repoId, oid, record);
        return response({ message: "Completed object size mismatch" }, 422);
      }
      record.completed = true;
      await storage.put(recordKey(oid), record);
    }
    // A completed multipart object has no trustworthy full-object SHA-256
    // metadata. Read the private R2 object as a stream and hash it here.
    // If this invocation fails, the next complete request retries verification.
    if (!await verifyCompletedObject(bucket, repoId, oid, record.size, request.signal)) {
      await abortMultipart(bucket, storage, repoId, oid, record);
      return response({ message: "Completed object SHA-256 or size mismatch" }, 422);
    }
    record.verified = true;
    await storage.put(recordKey(oid), record);
    await clearParts(storage, oid);
    return response({ oid, size: record.size });
  }
  return response({ message: "Unknown multipart operation" }, 404);
}
