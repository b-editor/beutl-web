import type { GitObjectBucket } from "./git-object-store";
import { readBodyAtMost } from "./git-http";
import type { GitScope } from "./tokens";
import { gitTokenSecret, issueMultipartToken } from "./tokens";
import type { GitStorageAccounting } from "./accounting";
import {
  abortMultipart,
  MAX_MULTIPART_OBJECT_BYTES,
  MULTIPART_RESERVATION_MS,
  verifyCompletedObject,
} from "./multipart";

const LFS_MEDIA_TYPE = "application/vnd.git-lfs+json";
const LFS_ACTION_SECONDS = 60 * 60;
const MAX_BATCH_OBJECTS = 100;
const MAX_LFS_REQUEST_BYTES = 32 * 1024;
// Use the conservative documented B2 single-request ceiling (decimal GB).
export const MAX_LFS_SINGLE_PUT_BYTES = 5_000_000_000;
export const LFS_BASIC_CLEANUP_GRACE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_REPO_QUOTA_BYTES = 20 * 1024 ** 3;
export const MAX_LFS_OBJECT_BYTES = 20 * 1024 ** 3;

export interface GitDurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<unknown>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  setAlarm(time: number): Promise<void>;
}

export interface LfsEnvironment {
  BEUTL_GIT_TOKEN_SECRET?: string;
  BEUTL_GIT_LFS_REPO_QUOTA_BYTES?: string;
}

export interface LfsRecord {
  size: number;
  verified: boolean;
  expiresAt: number;
  kind: "basic" | "multipart";
  uploadId?: string;
  completed?: boolean;
  versionId?: string;
  tusId?: string;
  gcComplete?: boolean;
  cleanupStarted?: boolean;
}

interface LfsObjectRequest { oid: string; size: number }
type LfsObjectResponse = LfsObjectRequest & {
  authenticated?: boolean;
  actions?: Record<string, unknown>;
  error?: { code: number; message: string };
};

function lfsResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Content-Type": LFS_MEDIA_TYPE, "Cache-Control": "no-store" },
  });
}

function validOid(oid: unknown): oid is string {
  return typeof oid === "string" && /^[0-9a-f]{64}$/u.test(oid);
}

function validSize(size: unknown): size is number {
  return typeof size === "number" && Number.isSafeInteger(size) && size >= 0;
}

function keyFor(repoId: string, oid: string): string {
  return `git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`;
}

async function hasVerifiedObject(bucket: GitObjectBucket, repoId: string, oid: string, record: LfsRecord): Promise<boolean> {
  if (!record.verified || !record.versionId) return false;
  const object = await bucket.head(keyFor(repoId, oid), record.versionId);
  return object?.size === record.size && object.versionId === record.versionId;
}

function getQuota(env: LfsEnvironment): number {
  const raw = env.BEUTL_GIT_LFS_REPO_QUOTA_BYTES;
  if (raw === undefined) return DEFAULT_REPO_QUOTA_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("BEUTL_GIT_LFS_REPO_QUOTA_BYTES must be a nonnegative safe integer");
  }
  return value;
}

export async function cleanupExpiredLfsRecord(
  storage: GitDurableStorage, bucket: GitObjectBucket, repoId: string, oid: string,
  record: LfsRecord, now: number, accounting?: GitStorageAccounting,
): Promise<void> {
  if (record.verified || record.expiresAt > now) return;
  if (record.kind === "multipart") {
    await abortMultipart(bucket, storage, repoId, oid, record, accounting);
    return;
  }
  const finalSweepAt = record.expiresAt + LFS_BASIC_CLEANUP_GRACE_MS;
  if (!record.cleanupStarted || now >= finalSweepAt) {
    await bucket.delete(keyFor(repoId, oid));
  }
  if (now < finalSweepAt) {
    await storage.put(`lfs:${oid}`, { ...record, cleanupStarted: true });
    await storage.setAlarm(finalSweepAt + 1000);
    return;
  }
  await accounting?.releaseLfs(repoId, oid);
  await storage.delete(`lfs:${oid}`);
}

export async function pruneExpiredLfs(
  storage: GitDurableStorage,
  bucket: GitObjectBucket,
  repoId: string,
  now = Date.now(),
  accounting?: GitStorageAccounting,
): Promise<void> {
  const records = await storage.list<LfsRecord>({ prefix: "lfs:" });
  for (const [key, record] of records) {
    if (record.verified && !record.gcComplete && record.versionId &&
        record.expiresAt + 2 * 60 * 60 * 1000 <= now && bucket.pruneVersions) {
      await bucket.pruneVersions(keyFor(repoId, key.slice(4)), [record.versionId]);
      await storage.put(key, { ...record, gcComplete: true });
    }
    if (!record.verified && record.expiresAt <= now) {
      await cleanupExpiredLfsRecord(storage, bucket, repoId, key.slice(4), record, now, accounting);
    }
  }
  const nextExpiry = [...records.values()]
    .map((record) => record.verified
      ? !record.gcComplete && bucket.pruneVersions ? record.expiresAt + 2 * 60 * 60 * 1000 : Infinity
      : record.kind === "basic" && record.expiresAt <= now
        ? record.expiresAt + LFS_BASIC_CLEANUP_GRACE_MS : record.expiresAt)
    .filter((time) => time > now)
    .reduce((earliest, time) => Math.min(earliest, time), Infinity);
  // Revisit even when no LFS record remains: CreateMultipartUpload may have
  // succeeded while its response was lost, leaving no recorded upload ID.
  const orphanSweep = bucket.cleanupMultipartUploads ? now + 24 * 60 * 60 * 1000 : Infinity;
  if (Number.isFinite(Math.min(nextExpiry, orphanSweep))) {
    await storage.setAlarm(Math.min(nextExpiry + 1000, orphanSweep));
  }
}

async function parseLfsJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(await readBodyAtMost(request, MAX_LFS_REQUEST_BYTES)));
  } catch (error) {
    if (error instanceof RangeError) throw error;
    return null;
  }
}

export async function handleLfsBatch(
  request: Request,
  bucket: GitObjectBucket,
  storage: GitDurableStorage,
  env: LfsEnvironment,
  repoId: string,
  scope: GitScope,
  authorization: string,
  accounting?: GitStorageAccounting,
): Promise<Response> {
  const input = await parseLfsJson(request) as {
    operation?: unknown; objects?: unknown; transfers?: unknown; hash_algo?: unknown;
  } | null;
  if (typeof input !== "object" || input === null ||
      (input.operation !== "upload" && input.operation !== "download") ||
      !Array.isArray(input.objects) || input.objects.length > MAX_BATCH_OBJECTS ||
      (input.transfers && (!Array.isArray(input.transfers) ||
        !input.transfers.some((transfer: unknown) =>
          transfer === "basic" || transfer === "beutl-tus" || transfer === "beutl-multipart"))) ||
      (input.hash_algo && input.hash_algo !== "sha256")) {
    return lfsResponse({ message: "Invalid Git LFS batch request" }, 400);
  }
  if (input.operation === "upload" && scope !== "write") {
    return lfsResponse({ message: "Write access is required" }, 403);
  }
  const transfers = Array.isArray(input.transfers) ? input.transfers : ["basic"];
  const needsMultipart = input.objects.some((object: unknown) =>
    typeof object === "object" && object !== null &&
    typeof (object as { size?: unknown }).size === "number" &&
    (object as { size: number }).size > MAX_LFS_SINGLE_PUT_BYTES);
  const customTransfer = (needsMultipart || !transfers.includes("basic"))
    ? transfers.includes("beutl-tus") ? "beutl-tus"
      : transfers.includes("beutl-multipart") ? "beutl-multipart" : null
    : null;
  const quota = getQuota(env);
  await pruneExpiredLfs(storage, bucket, repoId, Date.now(), accounting);
  const records = await storage.list<LfsRecord>({ prefix: "lfs:" });
  let reserved = [...records.values()].reduce((total, record) => total + record.size, 0);
  const objects: LfsObjectResponse[] = [];
  for (const object of input.objects as LfsObjectRequest[]) {
    const { oid, size } = object && typeof object === "object" ? object : { oid: undefined, size: undefined };
    if (!validOid(oid) || !validSize(size)) {
      objects.push({ oid: String(oid), size: validSize(size) ? size : 0, error: { code: 422, message: "Invalid OID or size" } });
      continue;
    }
    const key = keyFor(repoId, oid);
    const recordKey = `lfs:${oid}`;
    let record = records.get(recordKey);
    if (record && record.size !== size) {
      objects.push({ oid, size, error: { code: 422, message: "OID size does not match" } });
      continue;
    }
    if (input.operation === "download") {
      if (!record?.verified || !await hasVerifiedObject(bucket, repoId, oid, record)) {
        objects.push({ oid, size, error: { code: 404, message: "LFS object not found" } });
        continue;
      }
      objects.push({ oid, size, authenticated: true, actions: {
        download: {
          href: await bucket.presignGet(key, record.versionId!,
            record.kind === "multipart" ? Math.floor(MULTIPART_RESERVATION_MS / 1000) : LFS_ACTION_SECONDS),
          expires_in: record.kind === "multipart"
            ? Math.floor(MULTIPART_RESERVATION_MS / 1000) : LFS_ACTION_SECONDS,
        },
      } });
      continue;
    }
    if (record?.verified) {
      if (await hasVerifiedObject(bucket, repoId, oid, record)) {
        objects.push({ oid, size, authenticated: true });
      } else {
        objects.push({ oid, size, error: { code: 409, message: "Stored LFS object failed integrity check" } });
      }
      continue;
    }
    if (record && record.expiresAt <= Date.now()) {
      objects.push({ oid, size, error: { code: 409, message: "Expired LFS upload cleanup is pending" } });
      continue;
    }
    if (size > Math.min(MAX_MULTIPART_OBJECT_BYTES, MAX_LFS_OBJECT_BYTES) ||
        (size > MAX_LFS_SINGLE_PUT_BYTES && !customTransfer)) {
      objects.push({ oid, size, error: { code: 413, message: "The Beutl multipart LFS transfer is required for this object" } });
      continue;
    }
    // Git LFS chooses one transfer for the entire batch, including smaller
    // objects mixed with media above the Basic PUT limit.
    const multipart = customTransfer !== null;
    if (record && record.kind !== (multipart ? "multipart" : "basic")) {
      objects.push({ oid, size, error: { code: 409, message: "LFS transfer mode changed" } });
      continue;
    }
    if (multipart && record &&
        (record.tusId && customTransfer !== "beutl-tus" ||
          record.uploadId && !record.tusId && customTransfer === "beutl-tus")) {
      objects.push({ oid, size, error: { code: 409, message: "LFS transfer mode changed during upload" } });
      continue;
    }
    if (!record) {
      if (reserved + size > quota) {
        objects.push({ oid, size, error: { code: 413, message: "LFS repository quota exceeded" } });
        continue;
      }
      record = {
        size, verified: false,
        expiresAt: Date.now() + (multipart ? MULTIPART_RESERVATION_MS : LFS_ACTION_SECONDS * 1000),
        kind: multipart ? "multipart" : "basic",
      };
      if (accounting) {
        const ownerId = request.headers.get("x-beutl-git-owner-id") ?? "";
        const result = await accounting.reserveLfs({ repoId, oid, ownerId, size, expiresAt: record.expiresAt });
        if (result === "overQuota") {
          objects.push({ oid, size, error: { code: 413, message: "Account storage quota exceeded" } });
          continue;
        }
      }
      await storage.put(recordKey, record);
      records.set(recordKey, record);
      reserved += size;
      const earliest = [...records.values()]
        .filter((value) => !value.verified)
        .reduce((time, value) => Math.min(time, value.expiresAt), Infinity);
      await storage.setAlarm(earliest + 1000);
    }
    const actionSeconds = Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000));
    const uploadHref = multipart
      ? new URL(`/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/${customTransfer === "beutl-tus" ? "tus" : "multipart"}`,
        request.url).toString()
      : await bucket.presignPut(key, size, actionSeconds);
    const verifyHref = new URL(
      `/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/verify`, request.url,
    ).toString();
    const transferAuthorization = multipart
      ? `Bearer ${await issueMultipartToken(gitTokenSecret(env),
        // The Worker has already verified the Git token and owner; the
        // Durable Object does not receive the owner ID. Take it from the
        // verified token context forwarded by the Worker.
        request.headers.get("x-beutl-git-owner-id") ?? "", repoId, oid,
        Math.floor(Date.now() / 1000), Math.floor(record.expiresAt / 1000))}`
      : authorization;
    objects.push({ oid, size, authenticated: true, actions: {
      upload: multipart ? {
        href: uploadHref,
        header: { Authorization: transferAuthorization },
        expires_in: actionSeconds,
      } : {
        href: uploadHref,
        header: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(size),
        },
        expires_in: actionSeconds,
      },
      verify: {
        href: verifyHref,
        header: { Authorization: transferAuthorization },
        expires_in: actionSeconds,
      },
    } });
  }
  return lfsResponse({ transfer: customTransfer ?? "basic", objects });
}

export async function handleLfsVerify(
  request: Request,
  bucket: GitObjectBucket,
  storage: GitDurableStorage,
  repoId: string,
  oid: string,
  accounting?: GitStorageAccounting,
): Promise<Response> {
  if (!validOid(oid)) return lfsResponse({ message: "Invalid OID" }, 400);
  const input = await parseLfsJson(request) as { oid?: unknown; size?: unknown } | null;
  if (input?.oid !== oid || !validSize(input.size)) {
    return lfsResponse({ message: "Invalid verify request" }, 400);
  }
  const key = `lfs:${oid}`;
  const record = await storage.get<LfsRecord>(key);
  if (!record || record.size !== input.size || (!record.verified && record.expiresAt <= Date.now())) {
    return lfsResponse({ message: "LFS reservation not found" }, 404);
  }
  if (!record.verified && record.kind === "multipart") {
    return lfsResponse({ message: "Multipart object has not passed full SHA-256 verification" }, 422);
  }
  if (!record.verified && record.kind === "basic") {
    const object = await bucket.head(keyFor(repoId, oid));
    if (!object?.versionId || object.size !== record.size) {
      return lfsResponse({ message: "LFS size or SHA-256 verification failed" }, 422);
    }
    // Basic Git LFS verify expects one successful response. Use the native
    // streaming hash here; custom transfers advance persisted ranges instead.
    if (!await verifyCompletedObject(bucket, repoId, oid, record.size, object.versionId, request.signal)) {
      return lfsResponse({ message: "LFS size or SHA-256 verification failed" }, 422);
    }
    record.versionId = object.versionId;
    await accounting?.commitLfs(repoId, oid);
    record.verified = true;
    await storage.put(key, record);
  }
  if (!await hasVerifiedObject(bucket, repoId, oid, record)) {
    return lfsResponse({ message: "Verified LFS object version is unavailable" }, 404);
  }
  return lfsResponse({ oid, size: record.size });
}
