import type { GitObjectBucket } from "./git-object-store";
import { CheckpointSha256 } from "./checkpoint-sha256";
import { lfsKey, MAX_LFS_OBJECT_BYTES, MAX_TUS_PATCH_BYTES, MIN_TUS_PART_BYTES, type LfsRecord } from "./lfs";

type Stub = { fetch(request: Request): Promise<Response> };
type Record = LfsRecord & { digest?: string };
const HASH_STEP_BYTES = 32 * 1024 ** 2;
const integer = (s: string | null) => s !== null && /^\d+$/u.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : -1;
const tus = (status: number, headers: HeadersInit = {}, body?: string) => new Response(body ?? null, {
  status, headers: { "Tus-Resumable": "1.0.0", "Cache-Control": "no-store", ...headers },
});

async function metadata(stub: Stub, headers: Headers, oid: string, action: string, body?: unknown): Promise<Response> {
  const forwarded = new Headers({ "Content-Type": "application/json" });
  for (const name of ["x-beutl-repo-id", "x-beutl-git-owner-id", "x-beutl-git-scope", "authorization"])
    if (headers.has(name)) forwarded.set(name, headers.get(name)!);
  return stub.fetch(new Request(`https://git.internal/internal/git/media/${oid}/${action}`, {
    method: body === undefined ? "GET" : "POST", headers: forwarded,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
async function recordFrom(response: Response): Promise<Record> {
  if (!response.ok) throw new Error(`Git metadata request returned HTTP ${response.status}`);
  return response.json() as Promise<Record>;
}

export async function advanceVerification(
  bucket: GitObjectBucket, stub: Stub, headers: Headers, repoId: string, oid: string,
  record: Record, signal?: AbortSignal,
): Promise<Response> {
  const expectedOffset = record.checkpoint?.offset ?? 0;
  if (record.digest) return metadata(stub, headers, oid, "checkpoint", {
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
  return metadata(stub, headers, oid, "checkpoint", {
    resourceId: record.resourceId, versionId: record.versionId, expectedOffset,
    ...(complete ? { digest: hash.digestHex() } : { checkpoint: {
      version: 1, oid, size: record.size, versionId: record.versionId, ...hash.snapshot(),
    } }),
  });
}

async function uploadPart(
  bucket: GitObjectBucket, stub: Stub, headers: Headers, repoId: string, oid: string,
  record: Record, offset: number, length: number, body: ReadableStream<Uint8Array>,
): Promise<Response> {
  const prepare = await metadata(stub, headers, oid, "part", { resourceId: record.resourceId, offset, length });
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
    const part = await bucket.resumeMultipartUpload(lfsKey(repoId, oid), lease.uploadId)
      .uploadPart(lease.partNumber, bounded, length);
    return await metadata(stub, headers, oid, "accept", { resourceId: record.resourceId, leaseId: lease.leaseId, ...part });
  } catch (error) {
    await metadata(stub, headers, oid, "cancel", { resourceId: record.resourceId, leaseId: lease.leaseId })
      .catch(() => undefined);
    throw error;
  }
}

export async function handleTusWorker(
  request: Request, bucket: GitObjectBucket, stub: Stub, headers: Headers,
  repoId: string, oid: string, resourceId?: string,
): Promise<Response> {
  if (request.method === "OPTIONS") return tus(204, {
    "Tus-Version": "1.0.0", "Tus-Extension": "creation,expiration", "Tus-Max-Size": String(MAX_LFS_OBJECT_BYTES),
    "Upload-Min-Part-Size": String(MIN_TUS_PART_BYTES), "Upload-Max-Part-Size": String(MAX_TUS_PATCH_BYTES),
  });
  if (request.headers.get("tus-resumable") !== "1.0.0") return tus(412, { "Tus-Version": "1.0.0" });
  if (request.method === "POST" && !resourceId) {
    if (request.headers.get("upload-defer-length")) return tus(400, {}, "Upload-Length is required");
    const response = await metadata(stub, headers, oid, "create", { length: integer(request.headers.get("upload-length")) });
    if (!response.ok) return tus(response.status, {}, await response.text());
    const record = await recordFrom(response);
    return tus(201, { Location: `${new URL(request.url).origin}${new URL(request.url).pathname}/${record.resourceId}`,
      "Upload-Expires": new Date(record.expiresAt).toUTCString() });
  }
  if (!resourceId || !["HEAD", "PATCH"].includes(request.method)) return tus(405);
  const status = await metadata(stub, headers, oid, "status");
  if (!status.ok) return tus(status.status);
  let record = await recordFrom(status);
  if (record.resourceId !== resourceId) return tus(404);
  if (request.method === "PATCH") {
    if (request.headers.get("content-type")?.toLowerCase() !== "application/offset+octet-stream") return tus(415);
    const offset = integer(request.headers.get("upload-offset"));
    const length = integer(request.headers.get("content-length"));
    if (offset !== record.offset) return tus(409, { "Upload-Offset": String(record.offset) });
    if (!request.body || length < 0 || length > MAX_TUS_PATCH_BYTES) return tus(400);
    const receipt = await uploadPart(bucket, stub, headers, repoId, oid, record, offset, length, request.body);
    if (!receipt.ok) return tus(receipt.status, {}, await receipt.text());
    record = await recordFrom(receipt);
  }
  // Empty files need an empty S3 part; HEAD can recover its lost response too.
  if (record.size === 0 && record.partCount === 0 && !record.verified) {
    const empty = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const receipt = await uploadPart(bucket, stub, headers, repoId, oid, record, 0, 0, empty);
    if (!receipt.ok) return tus(receipt.status);
    record = await recordFrom(receipt);
  }
  if (record.offset === record.size && !record.verified) {
    const completed = await metadata(stub, headers, oid, "complete", { resourceId });
    if (!completed.ok) return tus(completed.status);
    record = await recordFrom(completed);
    const verified = await advanceVerification(bucket, stub, headers, repoId, oid, record, request.signal);
    if (!verified.ok) return tus(verified.status, {}, await verified.text());
    record = await recordFrom(verified);
  }
  return tus(request.method === "PATCH" ? 204 : 200, {
    "Upload-Offset": String(record.offset), "Upload-Length": String(record.size),
    "Upload-Verified": String(record.verified),
    ...(record.verified ? {} : { "Upload-Expires": new Date(record.expiresAt).toUTCString() }),
  });
}

export async function handleLfsDownload(
  request: Request, bucket: GitObjectBucket, stub: Stub, headers: Headers, repoId: string, oid: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
  const status = await metadata(stub, headers, oid, "status");
  if (!status.ok) return new Response(null, { status: status.status });
  const record = await recordFrom(status);
  if (!record.verified || !record.versionId) return new Response(null, { status: 404 });
  let range = request.headers.get("range") ?? undefined;
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/u.test(range))
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${record.size}` } });
  const key = lfsKey(repoId, oid);
  const ifRange = request.headers.get("if-range");
  if (range && ifRange) {
    const head = await bucket.download(key, record.versionId, "HEAD", undefined, request.signal);
    const modified = Date.parse(head.headers.get("last-modified") ?? "");
    if (!head.ok) return new Response(null, { status: head.status });
    if (ifRange !== head.headers.get("etag") && !(Number.isFinite(modified) && modified <= Date.parse(ifRange)))
      range = undefined;
  }
  const upstream = await bucket.download(key, record.versionId, request.method, range, request.signal);
  const responseHeaders = new Headers({ "Cache-Control": "private, no-store", "Accept-Ranges": "bytes" });
  for (const name of ["content-type", "content-length", "content-range", "etag", "last-modified"])
    if (upstream.headers.has(name)) responseHeaders.set(name, upstream.headers.get(name)!);
  // No buffering or redirect: the ordinary Worker owns the B2 fetch and stream.
  return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: responseHeaders });
}
