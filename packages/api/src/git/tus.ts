import type { GitDurableStorage, LfsRecord } from "./lfs";
import { MAX_LFS_OBJECT_BYTES } from "./lfs";
import type { GitObjectBucket } from "./git-object-store";
import { abortMultipart, advanceCompletedVerification, clearTusTail, MAX_MULTIPART_PARTS, MULTIPART_PART_BYTES } from "./multipart";
import type { GitStorageAccounting } from "./accounting";

// tus 1.0 core, Creation, Expiration and Termination. B2 needs at least 5 MiB
// for every non-final part; smaller PATCH tails live in SQLite DO storage.
const VERSION = "1.0.0";
const MIN_PART_BYTES = 5 * 1024 * 1024;
const TAIL_CHUNK_BYTES = 1024 * 1024;
const OID = /^[0-9a-f]{64}$/u;
const RESOURCE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
type Part = { partNumber: number; etag: string; size: number };
type Tail = { generation: "a" | "b"; base: number; length: number };

const recordKey = (oid: string) => `lfs:${oid}`;
const tailPrefix = (oid: string) => `tus-tail:${oid}:`;
const tailMetaKey = (oid: string) => `${tailPrefix(oid)}meta`;
const tailChunkKey = (oid: string, generation: string, index: number) =>
  `${tailPrefix(oid)}${generation}:${index}`;
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

async function activeTail(storage: GitDurableStorage, oid: string, base: number): Promise<Tail | undefined> {
  const tail = await storage.get<Tail>(tailMetaKey(oid));
  if (!tail) return undefined;
  if (tail.generation !== "a" && tail.generation !== "b" || !Number.isSafeInteger(tail.base) ||
      !Number.isSafeInteger(tail.length) || tail.length < 1 || tail.length >= MIN_PART_BYTES ||
      tail.base > base) {
    throw new Error("Invalid persisted tus tail");
  }
  // B2 may have accepted the part before the DO could remove its old tail.
  return tail.base === base ? tail : undefined;
}

async function readTail(storage: GitDurableStorage, oid: string, tail: Tail): Promise<Uint8Array> {
  const bytes = new Uint8Array(tail.length);
  for (let offset = 0, index = 0; offset < tail.length; index++) {
    const chunk = await storage.get<Uint8Array>(tailChunkKey(oid, tail.generation, index));
    const expected = Math.min(TAIL_CHUNK_BYTES, tail.length - offset);
    if (!(chunk instanceof Uint8Array) || chunk.byteLength !== expected) {
      throw new Error("Persisted tus tail is incomplete");
    }
    bytes.set(chunk, offset);
    offset += expected;
  }
  return bytes;
}

async function writeTail(storage: GitDurableStorage, oid: string, base: number, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength >= MIN_PART_BYTES) throw new Error("Tus tail exceeds B2 part minimum");
  if (bytes.byteLength) {
    const previous = await storage.get<Tail>(tailMetaKey(oid));
    const generation = previous?.generation === "a" ? "b" : "a";
    for (let offset = 0, index = 0; offset < bytes.byteLength; index++) {
      const end = Math.min(offset + TAIL_CHUNK_BYTES, bytes.byteLength);
      await storage.put(tailChunkKey(oid, generation, index), Uint8Array.from(bytes.subarray(offset, end)));
      offset = end;
    }
    // Commit the new generation last. An interrupted write leaves the previous
    // tail readable, and a lost response exposes the new offset on HEAD.
    await storage.put<Tail>(tailMetaKey(oid), { generation, base, length: bytes.byteLength });
  } else {
    await clearTusTail(storage, oid);
  }
}

async function status(
  bucket: GitObjectBucket, storage: GitDurableStorage, oid: string, record: LfsRecord, key: string,
): Promise<{ offset: number; base: number; parts: Part[]; tail?: Tail }> {
  if (record.completed || record.verified) return { offset: record.size, base: record.size, parts: [] };
  // A previous CompleteMultipartUpload may have succeeded before the DO
  // persisted its result. Do not call ListParts on an already completed upload.
  if (await bucket.head(key)) return { offset: record.size, base: record.size, parts: [] };
  if (!record.uploadId) return { offset: 0, base: 0, parts: [] };
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
  const tail = await activeTail(storage, oid, offset);
  if (offset + (tail?.length ?? 0) > record.size) throw new Error("Tus tail exceeds upload length");
  return { offset: offset + (tail?.length ?? 0), base: offset, parts, tail };
}

async function finish(
  bucket: GitObjectBucket, storage: GitDurableStorage, repoId: string, oid: string,
  record: LfsRecord, signal: AbortSignal, accounting?: GitStorageAccounting, knownParts?: Part[],
): Promise<"verified" | "pending" | "mismatch"> {
  if (record.verified) return "verified";
  const key = objectKey(repoId, oid);
  if (!record.completed) {
    let object = await bucket.head(key);
    if (!object) {
      if (!record.uploadId) throw new Error("B2 multipart upload is missing");
      const parts = knownParts ?? (await status(bucket, storage, oid, record, key)).parts;
      if (!parts.length || parts.reduce((sum, part) => sum + part.size, 0) !== record.size) {
        throw new Error("B2 multipart upload is incomplete");
      }
      object = await bucket.resumeMultipartUpload(key, record.uploadId).complete(
        parts.map(({ partNumber, etag }) => ({ partNumber, etag })),
      );
    }
    if (object.size !== record.size || !object.versionId) {
      await abortMultipart(bucket, storage, repoId, oid, record, accounting);
      return "mismatch";
    }
    // Persist the completed B2 version before the full hash. If this request
    // disappears, HEAD can retry verification without reassembling the file.
    record = { ...record, completed: true, versionId: object.versionId };
    await storage.put(recordKey(oid), record);
  }
  const verification = record.versionId ? await advanceCompletedVerification(
    bucket, storage, repoId, oid, record.size, record.versionId, signal) : "mismatch";
  if (verification === "pending") return "pending";
  if (verification !== "verified") {
    await abortMultipart(bucket, storage, repoId, oid, record, accounting);
    return "mismatch";
  }
  await accounting?.commitLfs(repoId, oid);
  await clearTusTail(storage, oid);
  await storage.put(recordKey(oid), { ...record, verified: true });
  return "verified";
}

export async function handleTus(
  request: Request, bucket: GitObjectBucket, storage: GitDurableStorage,
  repoId: string, oid: string, resourceId: string | undefined,
  accounting?: GitStorageAccounting,
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
      if (await finish(bucket, storage, repoId, oid, record, request.signal, accounting) !== "verified") {
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
      await clearTusTail(storage, oid);
      await storage.put(recordKey(oid), { ...record, tusId: undefined });
    } else {
      await abortMultipart(bucket, storage, repoId, oid, record, accounting);
    }
    return tusResponse(204);
  }
  if (method !== "HEAD" && method !== "PATCH") return tusResponse(405);

  const current = await status(bucket, storage, oid, record, key);
  if (current.offset === record.size && !record.verified) {
    const verification = await finish(bucket, storage, repoId, oid, record, request.signal, accounting, current.parts);
    if (verification === "mismatch") {
      return tusResponse(422, {}, "LFS object SHA-256 or size mismatch");
    }
    if (verification === "verified") record = { ...record, verified: true };
  }
  if (method === "HEAD") {
    return tusResponse(200, {
      "Upload-Offset": String(current.offset),
      "Upload-Length": String(record.size),
      "Upload-Verified": record.verified ? "true" : "false",
      ...(record.verified ? {} : { "Upload-Expires": expires(record) }),
    });
  }
  const patchExpires: Record<string, string> = record.verified
    ? {} : { "Upload-Expires": expires(record) };
  if (request.headers.get("Content-Type") !== "application/offset+octet-stream") {
    return tusResponse(415, patchExpires);
  }
  const offset = numberHeader(request.headers.get("Upload-Offset"));
  if (offset === null) return tusResponse(400, patchExpires, "Upload-Offset is required");
  if (offset !== current.offset) {
    return tusResponse(409, { ...patchExpires, "Upload-Offset": String(current.offset) });
  }
  const length = numberHeader(request.headers.get("x-beutl-tus-length") ??
    request.headers.get("Content-Length"));
  if (length === null) return tusResponse(411, patchExpires, "Content-Length is required");
  if (length > MULTIPART_PART_BYTES || offset + length > record.size) return tusResponse(413, patchExpires);
  if (length === 0) return tusResponse(204, { ...patchExpires, "Upload-Offset": String(offset) });
  if (!record.uploadId || !request.body) return tusResponse(409, patchExpires);
  const declaredLength = length;
  const uploadId = record.uploadId;
  const prefix = current.tail ? await readTail(storage, oid, current.tail) : new Uint8Array();
  const combined = prefix.byteLength + length;
  const final = current.base + combined === record.size;
  const uploadCount = combined < MIN_PART_BYTES && !final ? 0 :
    combined > MULTIPART_PART_BYTES && final ? 2 : 1;
  if (current.parts.length + uploadCount > MAX_MULTIPART_PARTS) return tusResponse(413, patchExpires);

  const reader = request.body.getReader();
  let prefixOffset = 0;
  let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let received = 0;
  async function take(maximum: number): Promise<Uint8Array | null> {
    while (true) {
      request.signal.throwIfAborted();
      if (prefixOffset < prefix.byteLength) {
        const end = Math.min(prefixOffset + maximum, prefix.byteLength);
        const chunk = prefix.subarray(prefixOffset, end);
        prefixOffset = end;
        return chunk;
      }
      if (buffered.byteLength) {
        const chunk = buffered.subarray(0, maximum);
        buffered = buffered.subarray(chunk.byteLength);
        return chunk;
      }
      const next = await reader.read();
      if (next.done) return null;
      received += next.value.byteLength;
      if (received > declaredLength) throw new RangeError("tus PATCH exceeds Content-Length");
      buffered = next.value;
    }
  }
  async function readBytes(size: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(size);
    for (let position = 0; position < size;) {
      const chunk = await take(Math.min(size - position, TAIL_CHUNK_BYTES));
      if (!chunk) throw new RangeError("tus PATCH is incomplete");
      bytes.set(chunk, position);
      position += chunk.byteLength;
    }
    return bytes;
  }
  async function assertDone(): Promise<void> {
    if (await take(1) || received !== declaredLength) throw new RangeError("tus PATCH length mismatch");
  }
  async function uploadPart(size: number, number: number): Promise<void> {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent === size) { controller.close(); return; }
        const chunk = await take(Math.min(size - sent, TAIL_CHUNK_BYTES));
        if (!chunk) throw new RangeError("tus PATCH is incomplete");
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    await bucket.resumeMultipartUpload(key, uploadId).uploadPart(number, stream, size);
    if (sent !== size) throw new RangeError("B2 did not read the full tus part");
  }
  try {
    if (uploadCount === 0) {
      const tail = await readBytes(combined);
      await assertDone();
      await writeTail(storage, oid, current.base, tail);
    } else {
      const first = Math.min(combined, MULTIPART_PART_BYTES);
      await uploadPart(first, current.parts.length + 1);
      if (combined > first && final) {
        await uploadPart(combined - first, current.parts.length + 2);
        await assertDone();
      } else if (combined > first) {
        const tail = await readBytes(combined - first);
        await assertDone();
        await writeTail(storage, oid, current.base + first, tail);
      } else {
        await assertDone();
        if (!final) await writeTail(storage, oid, current.base + first, new Uint8Array());
      }
    }
  } finally {
    reader.releaseLock();
  }
  const newOffset = offset + length;
  if (newOffset === record.size) {
    const accepted = await status(bucket, storage, oid, record, key);
    if (accepted.offset !== record.size) {
      return tusResponse(422, {}, "LFS object SHA-256 or size mismatch");
    }
    const verification = await finish(bucket, storage, repoId, oid, record, request.signal, accounting, accepted.parts);
    if (verification === "mismatch") {
      return tusResponse(422, {}, "LFS object SHA-256 or size mismatch");
    }
    return tusResponse(204, { "Upload-Offset": String(newOffset),
      "Upload-Verified": verification === "verified" ? "true" : "false",
      ...(verification === "verified" ? {} : { "Upload-Expires": expires(record) }) });
  }
  return tusResponse(204, { "Upload-Offset": String(newOffset),
    ...(newOffset === record.size ? {} : { "Upload-Expires": expires(record) }) });
}
