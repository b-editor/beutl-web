import { MAX_GIT_LFS_PART_BYTES } from "@beutl/core";
import type { GitObjectBucket } from "./git-object-store";
import type { GitAccess, GitMediaAction, GitRepositoryObject } from "./environment";
import { CheckpointSha256 } from "./checkpoint-sha256";
import { lfsKey, MAX_LFS_OBJECT_BYTES, MIN_TUS_PART_BYTES, readJson, type LfsRecord } from "./lfs";

// LFS bodies stream between the client and B2 in the ordinary Worker. The
// repository object only records reservations, offsets and receipts.

/** One LFS object of a repository whose access the route has already verified. */
export type LfsObject = { bucket: GitObjectBucket; repository: GitRepositoryObject; access: GitAccess; oid: string };

type Record = LfsRecord & { digest?: string };
const HASH_STEP_BYTES = 32 * 1024 ** 2;
const integer = (s: string | null) => s !== null && /^\d+$/u.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : -1;
// The route adds Tus-Resumable to every response on tus paths.
const tus = (status: number, headers: HeadersInit = {}, body?: string) => new Response(body ?? null, {
  status, headers: { "Cache-Control": "no-store", ...headers },
});

function metadata(object: LfsObject, action: "status" | GitMediaAction, body?: unknown): Promise<Response> {
  return object.repository.media(object.access, object.oid, action, body);
}
async function recordFrom(response: Response): Promise<Record> {
  if (!response.ok) throw new Error(`Git metadata request returned HTTP ${response.status}`);
  return response.json() as Promise<Record>;
}

async function advanceVerification(object: LfsObject, record: Record, signal?: AbortSignal): Promise<Response> {
  const { bucket, access: { repoId }, oid } = object;
  const expectedOffset = record.checkpoint?.offset ?? 0;
  if (record.digest) return metadata(object, "checkpoint", {
    resourceId: record.resourceId, versionId: record.versionId, expectedOffset, digest: record.digest,
  });
  if (!record.versionId) throw new Error("LFS verification requires a pinned version");
  const hash = new CheckpointSha256(record.checkpoint?.words, expectedOffset);
  const length = Math.min(HASH_STEP_BYTES, record.size - expectedOffset);
  if (length) {
    if (!bucket.getRange) throw new Error("B2 does not support verification ranges");
    const part = await bucket.getRange(lfsKey(repoId, oid), record.versionId, expectedOffset, length);
    if (part.size !== record.size || part.versionId !== record.versionId) throw new Error("LFS verification version changed");
    const reader = part.body.getReader(); let received = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const chunk = await reader.read(); if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > length) throw new Error("B2 verification range is too long");
        hash.update(chunk.value);
      }
      if (received !== length) throw new Error("B2 verification range is incomplete");
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    finally { reader.releaseLock(); }
  }
  const complete = expectedOffset + length === record.size;
  return metadata(object, "checkpoint", {
    resourceId: record.resourceId, versionId: record.versionId, expectedOffset,
    ...(complete ? { digest: hash.digestHex() } : { checkpoint: {
      version: 1, oid, size: record.size, versionId: record.versionId, ...hash.snapshot(),
    } }),
  });
}

async function uploadPart(
  object: LfsObject, record: Record, offset: number, length: number, body: ReadableStream<Uint8Array>,
): Promise<Response> {
  const prepare = await metadata(object, "part", { resourceId: record.resourceId, offset, length });
  if (!prepare.ok) return prepare;
  const lease = await prepare.json() as { uploadId: string; partNumber: number; leaseId: string };
  let received = 0;
  const bounded = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > length) throw new Error("tus body exceeds Content-Length");
      controller.enqueue(chunk);
    },
    flush() { if (received !== length) throw new Error("tus body is incomplete"); },
  }));
  try {
    const part = await object.bucket.resumeMultipartUpload(lfsKey(object.access.repoId, object.oid), lease.uploadId)
      .uploadPart(lease.partNumber, bounded, length);
    return await metadata(object, "accept", { resourceId: record.resourceId, leaseId: lease.leaseId, ...part });
  } catch (error) {
    // The part failure below is what the client must see. A lost cancel only
    // leaves the lease to expire, after which the client can retry the part.
    await metadata(object, "cancel", { resourceId: record.resourceId, leaseId: lease.leaseId })
      .catch(() => undefined);
    throw error;
  }
}

export function tusOptions(): Response {
  return tus(204, {
    "Tus-Version": "1.0.0", "Tus-Extension": "creation,expiration", "Tus-Max-Size": String(MAX_LFS_OBJECT_BYTES),
    "Upload-Min-Part-Size": String(MIN_TUS_PART_BYTES), "Upload-Max-Part-Size": String(MAX_GIT_LFS_PART_BYTES),
  });
}

export async function createTusUpload(request: Request, object: LfsObject): Promise<Response> {
  if (request.headers.get("upload-defer-length")) return tus(400, {}, "Upload-Length is required");
  const response = await metadata(object, "create", { length: integer(request.headers.get("upload-length")) });
  if (!response.ok) return tus(response.status, {}, await response.text());
  const record = await recordFrom(response);
  const url = new URL(request.url);
  return tus(201, { Location: `${url.origin}${url.pathname}/${record.resourceId}`,
    "Upload-Expires": new Date(record.expiresAt).toUTCString() });
}

async function currentUpload(object: LfsObject, resourceId: string): Promise<Record | Response> {
  const status = await metadata(object, "status");
  if (!status.ok) return tus(status.status);
  const record = await recordFrom(status);
  return record.resourceId === resourceId ? record : tus(404);
}

/** HEAD reports the accepted offset and also recovers completion after a lost PATCH response. */
export async function readTusUpload(request: Request, object: LfsObject, resourceId: string): Promise<Response> {
  const record = await currentUpload(object, resourceId);
  return record instanceof Response ? record : finishTusUpload(request, object, record, 200);
}

export async function appendTusUpload(request: Request, object: LfsObject, resourceId: string): Promise<Response> {
  const record = await currentUpload(object, resourceId);
  if (record instanceof Response) return record;
  if (request.headers.get("content-type")?.toLowerCase() !== "application/offset+octet-stream") return tus(415);
  const offset = integer(request.headers.get("upload-offset"));
  const length = integer(request.headers.get("content-length"));
  if (offset !== record.offset) return tus(409, { "Upload-Offset": String(record.offset) });
  if (!request.body || length < 0 || length > MAX_GIT_LFS_PART_BYTES) return tus(400);
  const receipt = await uploadPart(object, record, offset, length, request.body);
  if (!receipt.ok) return tus(receipt.status, {}, await receipt.text());
  return finishTusUpload(request, object, await recordFrom(receipt), 204);
}

async function finishTusUpload(request: Request, object: LfsObject, record: Record, status: number): Promise<Response> {
  // Empty files need an empty S3 part; HEAD can recover its lost response too.
  if (record.size === 0 && record.partCount === 0 && !record.verified) {
    const empty = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const receipt = await uploadPart(object, record, 0, 0, empty);
    if (!receipt.ok) return tus(receipt.status);
    record = await recordFrom(receipt);
  }
  if (record.offset === record.size && !record.verified) {
    const completed = await metadata(object, "complete", { resourceId: record.resourceId });
    if (!completed.ok) return tus(completed.status);
    record = await recordFrom(completed);
    const verified = await advanceVerification(object, record, request.signal);
    if (!verified.ok) return tus(verified.status, {}, await verified.text());
    record = await recordFrom(verified);
  }
  return tus(status, {
    "Upload-Offset": String(record.offset), "Upload-Length": String(record.size),
    "Upload-Verified": String(record.verified),
    ...(record.verified ? {} : { "Upload-Expires": new Date(record.expiresAt).toUTCString() }),
  });
}

const lfs = (status: number, message?: string) => new Response(message === undefined ? null : JSON.stringify({ message }), {
  status, headers: { "Content-Type": "application/vnd.git-lfs+json", "Cache-Control": "no-store" },
});

/** The basic transfer's verify action, sent after the client PUT the object to B2. */
export async function verifyLfsUpload(request: Request, object: LfsObject): Promise<Response> {
  let input: any;
  try { input = await readJson(request); } catch {
    // Malformed JSON is the client's protocol error.
    return lfs(400, "Invalid LFS verify request");
  }
  if (input?.oid !== object.oid || !Number.isSafeInteger(input.size)) return lfs(422, "Invalid LFS verify request");
  const verified = await metadata(object, "verify", { size: input.size });
  return verified.ok ? lfs(200) : lfs(verified.status, await verified.text());
}

/** Streams the recorded B2 version for GET and HEAD, with single ranges and If-Range. */
export async function downloadLfsObject(request: Request, object: LfsObject): Promise<Response> {
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const status = await metadata(object, "status");
  if (!status.ok) return new Response(null, { status: status.status });
  const record = await recordFrom(status);
  if (!record.verified || !record.versionId) return new Response(null, { status: 404 });
  let range = request.headers.get("range") ?? undefined;
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/u.test(range))
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${record.size}` } });
  const key = lfsKey(object.access.repoId, object.oid);
  const ifRange = request.headers.get("if-range");
  if (range && ifRange) {
    const head = await object.bucket.download(key, record.versionId, "HEAD", undefined, request.signal);
    const modified = Date.parse(head.headers.get("last-modified") ?? "");
    if (!head.ok) return new Response(null, { status: head.status });
    if (ifRange !== head.headers.get("etag") && !(Number.isFinite(modified) && modified <= Date.parse(ifRange)))
      range = undefined;
  }
  const upstream = await object.bucket.download(key, record.versionId, method, range, request.signal);
  const responseHeaders = new Headers({ "Cache-Control": "private, no-store", "Accept-Ranges": "bytes" });
  for (const name of ["content-type", "content-length", "content-range", "etag", "last-modified"])
    if (upstream.headers.has(name)) responseHeaders.set(name, upstream.headers.get(name)!);
  // No buffering or redirect: the ordinary Worker owns the B2 fetch and stream.
  return new Response(method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: responseHeaders });
}
