import { MAX_GIT_LFS_PART_BYTES } from "@beutl/core";
import type { GitObjectBucket } from "./git-object-store";
import type { GitStorageAccounting } from "./accounting";
import { readBodyAtMost } from "./git-http";
import type { Sha256State } from "./resumable-sha256";
import { sha256Base64 } from "./s3-object-store";
import type { GitScope } from "./tokens";

/** B2 multipart uploads have at most 10,000 parts, and each tus PATCH stores one. */
export const MAX_LFS_PARTS = 10_000;
export const MAX_LFS_OBJECT_BYTES = MAX_LFS_PARTS * MAX_GIT_LFS_PART_BYTES;
// Bounds the records a batch lists and the repository object sweeps.
const MAX_LFS_OBJECTS = 10_000;
/** B2 accepts one PUT of at most 5 GB; larger objects need the desktop's beutl-tus agent. */
export const MAX_BASIC_LFS_OBJECT_BYTES = 5_000_000_000;
export const MIN_TUS_PART_BYTES = 5 * 1024 ** 2;
export const UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;
// Git LFS asks for a new batch when an action expires before its transfer starts.
const UPLOAD_URL_LIFETIME_MS = 60 * 60_000;
/** An upload batch rewrites `touchedAt` only when it is at least this old. */
export const LFS_TOUCH_PRECISION_MS = 60 * 60_000;
export interface GitDurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string | string[]): Promise<unknown>;
  list<T>(options: { prefix: string; startAfter?: string; limit?: number }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}
export interface LfsRecord {
  size: number; expiresAt: number; verified: boolean;
  resourceId: string; uploadId?: string; versionId?: string;
  offset: number; partCount: number;
  /** SHA-256 of the first `offset` bytes, and the digest once every byte arrived. */
  hash?: Sha256State; digest?: string;
  /** When the object was last uploaded or offered to an upload batch; collection waits a grace period from it. */
  touchedAt?: number;
  lease?: { id: string; until: number; offset: number; length: number };
  /** Parts are numbered by offset and may arrive out of order; see LfsPart. */
  parallel?: boolean;
}
/**
 * A stored B2 part. In a parallel upload it also keeps the SHA-256 state its
 * client said the part starts from and the state the part's bytes led to; the
 * accepted offset passes a part only when its start continues the bytes before.
 */
export type LfsPart = {
  /** Absent while the part's only upload is still in flight. */
  etag?: string;
  partNumber: number; length?: number; start?: Sha256State; end?: Sha256State; digest?: string;
  lease?: { id: string; until: number; start?: Sha256State };
};
export const lfsKey = (repoId: string, oid: string) => `git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`;
export const partPrefix = (oid: string) => `part:${oid}:`;
export const partKey = (oid: string, n: number) => `${partPrefix(oid)}${String(n).padStart(5, "0")}`;
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
export async function scheduleGitMaintenance(storage: GitDurableStorage, time: number): Promise<void> {
  const alarm = await storage.getAlarm();
  if (alarm === null || time < alarm) await storage.setAlarm(time);
}
export async function readJson(request: Request): Promise<any> {
  return JSON.parse(new TextDecoder().decode(await readBodyAtMost(request, 32 * 1024)));
}

export async function cleanupLfs(
  storage: GitDurableStorage, bucket: GitObjectBucket, accounting: GitStorageAccounting | undefined,
  repoId: string, oid: string, record?: LfsRecord,
): Promise<void> {
  if (record?.verified) return;
  const key = lfsKey(repoId, oid);
  if (record?.uploadId) await bucket.resumeMultipartUpload(key, record.uploadId).abort();
  // Also covers a successful CreateMultipartUpload whose response was lost.
  await bucket.cleanupMultipartUploads?.(key, [], Infinity);
  await bucket.delete(key);
  await accounting?.releaseLfs(repoId, oid);
  const parts = await storage.list({ prefix: partPrefix(oid) });
  if (parts.size) await storage.delete([...parts.keys()]);
  await storage.delete(`lfs:${oid}`);
}

export async function handleLfsBatch(
  request: Request, bucket: GitObjectBucket, storage: GitDurableStorage, repoId: string, scope: GitScope,
  accounting?: GitStorageAccounting,
): Promise<Response> {
  let input: any;
  try { input = await readJson(request); } catch {
    // Malformed batch JSON is the client's protocol error.
    return json({ message: "Invalid LFS batch" }, 400);
  }
  if (!input || !["upload", "download"].includes(input.operation) ||
      (input.transfers !== undefined && !Array.isArray(input.transfers)) ||
      !Array.isArray(input.objects) || input.objects.length > 100 ||
      input.objects.some((o: any) => !o || !/^[0-9a-f]{64}$/u.test(o.oid) ||
        !Number.isSafeInteger(o.size) || o.size < 0))
    return json({ message: "Invalid LFS batch" }, 400);
  if (input.operation === "upload" && scope !== "write") return json({ message: "Forbidden" }, 403);
  // The desktop's agent resumes uploads of any size; stock Git LFS PUTs each object to B2.
  const transfer = input.transfers?.includes("beutl-tus") ? "beutl-tus" : "basic";
  if (input.transfers && !input.transfers.includes(transfer))
    return json({ message: "LFS needs the basic or beutl-tus transfer" }, 422);
  const ownerId = request.headers.get("x-beutl-git-owner-id") ?? "";
  const authorization = request.headers.get("authorization");
  const base = `${new URL(request.url).origin}/api/v3/git/${repoId}.git/info/lfs/objects`;
  const objects = [];
  let stored: number | undefined;
  for (const object of input.objects) {
    const { oid, size } = object;
    let record = await storage.get<LfsRecord>(`lfs:${oid}`);
    if (record && !record.verified && record.expiresAt <= Date.now()) {
      await cleanupLfs(storage, bucket, accounting, repoId, oid, record);
      record = undefined;
    }
    if (record && record.size !== size) {
      objects.push({ oid, size, error: { code: 409, message: "LFS size differs from its reservation" } }); continue;
    }
    if (input.operation === "download") {
      objects.push(record?.verified && record.versionId
        ? { oid, size, authenticated: true, actions: { download: {
          href: `${base}/${oid}/download`, header: { Authorization: authorization },
        } } }
        : { oid, size, error: { code: 404, message: "LFS object is not verified" } });
      continue;
    }
    if (record?.verified) {
      // The client may be about to push a commit that points here.
      if (Date.now() - (record.touchedAt ?? 0) > LFS_TOUCH_PRECISION_MS) await storage.put(`lfs:${oid}`, { ...record, touchedAt: Date.now() });
      objects.push({ oid, size }); continue;
    }
    // Objects already stored need no transfer, whatever their size.
    if (size > (transfer === "basic" ? MAX_BASIC_LFS_OBJECT_BYTES : MAX_LFS_OBJECT_BYTES)) {
      objects.push({ oid, size, error: { code: 422, message: size > MAX_LFS_OBJECT_BYTES
        ? `LFS objects are limited to ${MAX_LFS_OBJECT_BYTES / 1024 ** 3} GiB`
        : "LFS objects over 5 GB need the Beutl desktop app" } });
      continue;
    }
    if (!record) {
      stored ??= (await storage.list({ prefix: "lfs:" })).size;
      if (stored >= MAX_LFS_OBJECTS) {
        objects.push({ oid, size, error: { code: 413, message: "Repositories are limited to 10,000 LFS objects" } }); continue;
      }
      const expiresAt = Date.now() + UPLOAD_LIFETIME_MS;
      if (await accounting?.reserveLfs({ repoId, oid, ownerId, size, expiresAt }) === "overQuota") {
        objects.push({ oid, size, error: { code: 413, message: "Account storage quota exceeded" } }); continue;
      }
      record = { size, expiresAt, verified: false, resourceId: crypto.randomUUID(), offset: 0, partCount: 0 };
      await storage.put(`lfs:${oid}`, record);
      stored++;
      await scheduleGitMaintenance(storage, expiresAt + 1000);
    }
    // The client's own repository credential authorizes tus and verification requests.
    const credential = { Authorization: authorization };
    const reservedUntil = new Date(record.expiresAt).toISOString();
    const verify = { href: `${base}/${oid}/verify`, header: credential, expires_at: reservedUntil };
    if (transfer === "beutl-tus") {
      objects.push({ oid, size, authenticated: true, actions: {
        upload: { href: `${base}/${oid}/tus`, header: credential, expires_at: reservedUntil }, verify,
      } });
      continue;
    }
    if (!bucket.presignUpload) throw new Error("Object storage cannot presign LFS uploads");
    const lifetime = Math.max(1000, Math.min(UPLOAD_URL_LIFETIME_MS, record.expiresAt - Date.now()));
    objects.push({ oid, size, authenticated: true, actions: {
      // B2 stores the PUT body only if its length and SHA-256 match this object.
      upload: {
        href: await bucket.presignUpload(lfsKey(repoId, oid), size, oid, Math.floor(lifetime / 1000)),
        header: { "x-amz-checksum-sha256": sha256Base64(oid) },
        expires_at: new Date(Date.now() + lifetime).toISOString(),
      },
      verify,
    } });
  }
  return new Response(JSON.stringify({ transfer, objects }), {
    headers: { "Content-Type": "application/vnd.git-lfs+json", "Cache-Control": "no-store" },
  });
}
