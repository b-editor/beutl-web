import type { GitDurableStorage, LfsRecord } from "./lfs";
import { MAX_LFS_OBJECT_BYTES } from "./lfs";
import type { GitObjectBucket } from "./git-object-store";
import { abortMultipart, MAX_MULTIPART_PARTS, MULTIPART_PART_BYTES, verifyCompletedObject } from "./multipart";

// tus 1.0 core, Creation, Expiration and Termination. B2 needs at least 5 MiB
// for every non-final part; 64 MiB stays below Cloudflare's 100 MB body cap.
const VERSION = "1.0.0";
const MIN_PART_BYTES = 5 * 1024 * 1024;
const OID = /^[0-9a-f]{64}$/u;
const RESOURCE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
type Part = { partNumber: number; etag: string; size: number };

const recordKey = (oid: string) => `lfs:${oid}`;
const objectKey = (repoId: string, oid: string) => `git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`;
const expires = (record: LfsRecord) => new Date(record.expiresAt).toUTCString();
const numberHeader = (value: string | null): number | null =>
  value !== null && DECIMAL.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

function tusResponse(status: number, headers: Record<string, string> = {}, message?: string): Response {
  return new Response(message ?? null, {
    status,
    headers: { "Tus-Resumable": VERSION, "Cache-Control": "no-store", ...headers },
  });
}

async function status(
  bucket: GitObjectBucket, record: LfsRecord, key: string,
): Promise<{ offset: number; parts: Part[] }> {
  if (record.completed || record.verified) return { offset: record.size, parts: [] };
  // A previous CompleteMultipartUpload may have succeeded before the DO
  // persisted its result. Do not call ListParts on an already completed upload.
  if (await bucket.head(key)) return { offset: record.size, parts: [] };
  if (!record.uploadId) return { offset: 0, parts: [] };
  const parts = (await bucket.resumeMultipartUpload(key, record.uploadId).listParts())
    .sort((a, b) => a.partNumber - b.partNumber);
  if (parts.length > MAX_MULTIPART_PARTS) throw new Error("B2 multipart part count exceeded");
  let offset = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part.partNumber !== index + 1 || !part.etag ||
        !Number.isSafeInteger(part.size) || part.size < 1 || part.size > MULTIPART_PART_BYTES ||
        offset + part.size > record.size ||
        (offset + part.size < record.size && part.size < MIN_PART_BYTES)) {
      throw new Error("B2 multipart parts do not form a valid tus offset");
    }
    offset += part.size;
  }
  return { offset, parts };
}

async function finish(
  bucket: GitObjectBucket, storage: GitDurableStorage, repoId: string, oid: string,
  record: LfsRecord, signal: AbortSignal, knownParts?: Part[],
): Promise<boolean> {
  if (record.verified) return true;
  const key = objectKey(repoId, oid);
  if (!record.completed) {
    let object = await bucket.head(key);
    if (!object) {
      if (!record.uploadId) throw new Error("B2 multipart upload is missing");
      const parts = knownParts ?? (await status(bucket, record, key)).parts;
      if (!parts.length || parts.reduce((sum, part) => sum + part.size, 0) !== record.size) {
        throw new Error("B2 multipart upload is incomplete");
      }
      object = await bucket.resumeMultipartUpload(key, record.uploadId).complete(
        parts.map(({ partNumber, etag }) => ({ partNumber, etag })),
      );
    }
    if (object.size !== record.size || !object.versionId) {
      await abortMultipart(bucket, storage, repoId, oid, record);
      return false;
    }
    // Persist the completed B2 version before the full hash. If this request
    // disappears, HEAD can retry verification without reassembling the file.
    record = { ...record, completed: true, versionId: object.versionId };
    await storage.put(recordKey(oid), record);
  }
  if (!record.versionId || !await verifyCompletedObject(
    bucket, repoId, oid, record.size, record.versionId, signal)) {
    await abortMultipart(bucket, storage, repoId, oid, record);
    return false;
  }
  await storage.put(recordKey(oid), { ...record, verified: true });
  return true;
}

export async function handleTus(
  request: Request, bucket: GitObjectBucket, storage: GitDurableStorage,
  repoId: string, oid: string, resourceId: string | undefined,
): Promise<Response> {
  if (!OID.test(oid)) return tusResponse(404);
  const method = request.method === "POST" &&
    request.headers.get("x-http-method-override") === "PATCH" ? "PATCH" : request.method;
  if (method === "OPTIONS") {
    return tusResponse(204, {
      "Tus-Version": VERSION,
      "Tus-Extension": "creation,expiration,termination",
      "Tus-Max-Size": String(MAX_LFS_OBJECT_BYTES),
    });
  }
  if (request.headers.get("Tus-Resumable") !== VERSION) {
    return tusResponse(412, { "Tus-Version": VERSION });
  }
  let record = await storage.get<LfsRecord>(recordKey(oid));
  if (!record || record.kind !== "multipart") return tusResponse(404);
  if (!record.verified && record.expiresAt <= Date.now()) return tusResponse(410);
  const key = objectKey(repoId, oid);

  if (method === "POST" && resourceId === undefined) {
    const length = numberHeader(request.headers.get("Upload-Length"));
    if (length === null) return tusResponse(400, {}, "Upload-Length is required");
    if (length > MAX_LFS_OBJECT_BYTES) return tusResponse(413);
    if (length !== record.size) return tusResponse(409);
    if (request.body && (await request.arrayBuffer()).byteLength !== 0) {
      return tusResponse(400, {}, "Creation with upload is not supported");
    }
    if (!record.tusId) {
      if (record.uploadId || record.completed) return tusResponse(409);
      record = { ...record, tusId: crypto.randomUUID() };
      await storage.put(recordKey(oid), record);
    }
    if (record.size === 0 && !record.verified) {
      if (!await bucket.head(key)) await bucket.put(key, new Uint8Array());
      if (!await finish(bucket, storage, repoId, oid, record, request.signal)) {
        return tusResponse(422, {}, "LFS object SHA-256 or size mismatch");
      }
      record = { ...record, verified: true };
    } else if (!record.uploadId && !record.completed) {
      const upload = await bucket.createMultipartUpload(key);
      record = { ...record, uploadId: upload.uploadId };
      await storage.put(recordKey(oid), record);
    }
    const location = new URL(`${new URL(request.url).pathname.replace(/\/$/u, "")}/${record.tusId}`, request.url);
    return tusResponse(201, { Location: location.toString(),
      ...(record.verified ? {} : { "Upload-Expires": expires(record) }) });
  }

  if (!resourceId || !RESOURCE_ID.test(resourceId) || record.tusId !== resourceId) {
    return tusResponse(404);
  }
  if (method === "DELETE") {
    if (record.verified) {
      await storage.put(recordKey(oid), { ...record, tusId: undefined });
    } else {
      await abortMultipart(bucket, storage, repoId, oid, record);
    }
    return tusResponse(204);
  }
  if (method !== "HEAD" && method !== "PATCH") return tusResponse(405);

  const current = await status(bucket, record, key);
  if (current.offset === record.size && !record.verified) {
    if (!await finish(bucket, storage, repoId, oid, record, request.signal, current.parts)) {
      return tusResponse(422, {}, "LFS object SHA-256 or size mismatch");
    }
    record = { ...record, verified: true };
  }
  if (method === "HEAD") {
    return tusResponse(200, {
      "Upload-Offset": String(current.offset),
      "Upload-Length": String(record.size),
      ...(record.verified ? {} : { "Upload-Expires": expires(record) }),
    });
  }
  if (request.headers.get("Content-Type") !== "application/offset+octet-stream") {
    return tusResponse(415);
  }
  const offset = numberHeader(request.headers.get("Upload-Offset"));
  if (offset === null) return tusResponse(400, {}, "Upload-Offset is required");
  if (offset !== current.offset) {
    return tusResponse(409, { "Upload-Offset": String(current.offset) });
  }
  const length = numberHeader(request.headers.get("x-beutl-tus-length") ??
    request.headers.get("Content-Length"));
  if (length === null) return tusResponse(411, {}, "Content-Length is required");
  if (length > MULTIPART_PART_BYTES || offset + length > record.size) return tusResponse(413);
  if (length !== 0 && offset + length < record.size && length < MIN_PART_BYTES) {
    return tusResponse(400, { "Upload-Offset": String(offset) }, "B2 requires non-final chunks of at least 5 MiB");
  }
  if (length === 0) return tusResponse(204, { "Upload-Offset": String(offset) });
  if (!record.uploadId || !request.body || current.parts.length >= MAX_MULTIPART_PARTS) {
    return tusResponse(409);
  }
  let received = 0;
  const measured = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      request.signal.throwIfAborted();
      received += chunk.byteLength;
      if (received > length) throw new RangeError("tus PATCH exceeds Content-Length");
      controller.enqueue(chunk);
    },
    flush() {
      if (received !== length) throw new RangeError("tus PATCH is incomplete");
    },
  }));
  await bucket.resumeMultipartUpload(key, record.uploadId)
    .uploadPart(current.parts.length + 1, measured, length);
  if (received !== length) return tusResponse(422);
  const newOffset = offset + length;
  if (newOffset === record.size) {
    const accepted = await status(bucket, record, key);
    if (accepted.offset !== record.size ||
        !await finish(bucket, storage, repoId, oid, record, request.signal, accepted.parts)) {
      return tusResponse(422, {}, "LFS object SHA-256 or size mismatch");
    }
  }
  return tusResponse(204, { "Upload-Offset": String(newOffset),
    ...(newOffset === record.size ? {} : { "Upload-Expires": expires(record) }) });
}
