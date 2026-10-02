import { AwsClient } from "aws4fetch";
import type { GitR2Bucket } from "./r2-object-store";
import { readBodyAtMost } from "./git-http";
import type { GitScope } from "./tokens";
import { gitTokenSecret, issueMultipartToken } from "./tokens";
import {
  abortMultipart,
  MAX_MULTIPART_OBJECT_BYTES,
  MULTIPART_RESERVATION_MS,
} from "./multipart";

const LFS_MEDIA_TYPE = "application/vnd.git-lfs+json";
const LFS_ACTION_SECONDS = 60 * 60;
const MAX_BATCH_OBJECTS = 100;
const MAX_LFS_REQUEST_BYTES = 32 * 1024;
export const MAX_LFS_SINGLE_PUT_BYTES = 5 * 1024 ** 3;
const DEFAULT_REPO_QUOTA_BYTES = 20 * 1024 ** 3;

export interface GitDurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<unknown>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  setAlarm(time: number): Promise<void>;
}

export interface LfsEnvironment {
  BEUTL_GIT_TOKEN_SECRET?: string;
  BEUTL_GIT_R2_S3_ENDPOINT?: string;
  BEUTL_GIT_R2_S3_BUCKET?: string;
  BEUTL_GIT_R2_S3_ACCESS_KEY_ID?: string;
  BEUTL_GIT_R2_S3_SECRET_ACCESS_KEY?: string;
  BEUTL_GIT_LFS_REPO_QUOTA_BYTES?: string;
}

export interface LfsRecord {
  size: number;
  verified: boolean;
  expiresAt: number;
  kind: "basic" | "multipart";
  uploadId?: string;
  completed?: boolean;
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

function checksumBase64(oid: string): string {
  let bytes = "";
  for (let i = 0; i < oid.length; i += 2) {
    bytes += String.fromCharCode(Number.parseInt(oid.slice(i, i + 2), 16));
  }
  return btoa(bytes);
}

function checksumHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hasMatchingObject(
  bucket: GitR2Bucket,
  repoId: string,
  oid: string,
  size: number,
): Promise<boolean> {
  const object = await bucket.head(keyFor(repoId, oid));
  return object?.size === size && object.checksums?.sha256 !== undefined &&
    checksumHex(object.checksums.sha256) === oid;
}

async function hasVerifiedObject(bucket: GitR2Bucket, repoId: string, oid: string, record: LfsRecord): Promise<boolean> {
  if (record.kind === "basic") return hasMatchingObject(bucket, repoId, oid, record.size);
  const object = await bucket.head(keyFor(repoId, oid));
  // Multipart content was fully streamed and hashed before record.verified
  // became true; R2 does not expose a full SHA-256 for multipart objects.
  return record.verified && object?.size === record.size;
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

function signingConfig(env: LfsEnvironment): {
  client: AwsClient;
  objectUrl: (key: string, expiresSeconds: number) => string;
} {
  let endpoint: URL;
  try {
    endpoint = new URL(env.BEUTL_GIT_R2_S3_ENDPOINT ?? "");
  } catch {
    throw new Error("Hosted Git LFS R2 signing is not configured");
  }
  const bucket = env.BEUTL_GIT_R2_S3_BUCKET;
  const accessKeyId = env.BEUTL_GIT_R2_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.BEUTL_GIT_R2_S3_SECRET_ACCESS_KEY;
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== "/" ||
      !bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) ||
      !accessKeyId || !secretAccessKey) {
    throw new Error("Hosted Git LFS R2 signing is not configured");
  }
  const client = new AwsClient({ service: "s3", region: "auto", accessKeyId, secretAccessKey });
  return {
    client,
    objectUrl: (key, expiresSeconds) =>
      `${endpoint.origin}/${bucket}/${key}?X-Amz-Expires=${expiresSeconds}`,
  };
}

async function signedUrl(
  config: ReturnType<typeof signingConfig>,
  key: string,
  method: "GET" | "PUT",
  oid?: string,
  size?: number,
  expiresSeconds = LFS_ACTION_SECONDS,
): Promise<string> {
  const headers = method === "PUT" && oid !== undefined && size !== undefined
    ? {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
        "x-amz-checksum-sha256": checksumBase64(oid),
      }
    : undefined;
  const request = new Request(config.objectUrl(key, expiresSeconds), { method, headers });
  const signed = await config.client.sign(request, { aws: { signQuery: true, allHeaders: true } });
  return signed.url;
}

export async function pruneExpiredLfs(
  storage: GitDurableStorage,
  bucket: GitR2Bucket,
  repoId: string,
  now = Date.now(),
): Promise<void> {
  const records = await storage.list<LfsRecord>({ prefix: "lfs:" });
  for (const [key, record] of records) {
    if (!record.verified && record.expiresAt <= now) {
      if (record.kind === "multipart") {
        await abortMultipart(bucket, storage, repoId, key.slice(4), record);
      } else {
        await storage.delete(key);
        await bucket.delete(keyFor(repoId, key.slice(4)));
      }
    }
  }
  const nextExpiry = [...records.values()]
    .filter((record) => !record.verified && record.expiresAt > now)
    .reduce((earliest, record) => Math.min(earliest, record.expiresAt), Infinity);
  if (Number.isFinite(nextExpiry)) await storage.setAlarm(nextExpiry + 1000);
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
  bucket: GitR2Bucket,
  storage: GitDurableStorage,
  env: LfsEnvironment,
  repoId: string,
  scope: GitScope,
  authorization: string,
): Promise<Response> {
  const input = await parseLfsJson(request) as {
    operation?: unknown; objects?: unknown; transfers?: unknown; hash_algo?: unknown;
  } | null;
  if (typeof input !== "object" || input === null ||
      (input.operation !== "upload" && input.operation !== "download") ||
      !Array.isArray(input.objects) || input.objects.length > MAX_BATCH_OBJECTS ||
      (input.transfers && (!Array.isArray(input.transfers) ||
        !input.transfers.some((transfer: unknown) => transfer === "basic" || transfer === "beutl-r2-multipart"))) ||
      (input.hash_algo && input.hash_algo !== "sha256")) {
    return lfsResponse({ message: "Invalid Git LFS batch request" }, 400);
  }
  if (input.operation === "upload" && scope !== "write") {
    return lfsResponse({ message: "Write access is required" }, 403);
  }
  const config = signingConfig(env);
  const transfers = Array.isArray(input.transfers) ? input.transfers : ["basic"];
  const needsMultipart = input.objects.some((object: unknown) =>
    typeof object === "object" && object !== null &&
    typeof (object as { size?: unknown }).size === "number" &&
    (object as { size: number }).size > MAX_LFS_SINGLE_PUT_BYTES);
  const customTransfer = transfers.includes("beutl-r2-multipart") &&
    (needsMultipart || !transfers.includes("basic"));
  const quota = getQuota(env);
  await pruneExpiredLfs(storage, bucket, repoId);
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
          href: await signedUrl(config, key, "GET", undefined, undefined,
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
    if (size > MAX_MULTIPART_OBJECT_BYTES || (size > MAX_LFS_SINGLE_PUT_BYTES && !customTransfer)) {
      objects.push({ oid, size, error: { code: 413, message: "The Beutl multipart LFS transfer is required for this object" } });
      continue;
    }
    const multipart = size > MAX_LFS_SINGLE_PUT_BYTES;
    if (record && record.kind !== (multipart ? "multipart" : "basic")) {
      objects.push({ oid, size, error: { code: 409, message: "LFS transfer mode changed" } });
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
      await storage.put(recordKey, record);
      records.set(recordKey, record);
      reserved += size;
      const earliest = [...records.values()]
        .filter((value) => !value.verified)
        .reduce((time, value) => Math.min(time, value.expiresAt), Infinity);
      await storage.setAlarm(earliest + 1000);
    }
    const uploadHref = multipart
      ? new URL(`/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/multipart`, request.url).toString()
      : await signedUrl(config, key, "PUT", oid, size);
    const verifyHref = new URL(
      `/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/verify`, request.url,
    ).toString();
    const transferAuthorization = multipart
      ? `Bearer ${await issueMultipartToken(gitTokenSecret(env),
        // The Worker has already verified the Git token and owner; the
        // Durable Object does not receive the owner ID. Take it from the
        // verified token context forwarded by the Worker.
        request.headers.get("x-beutl-git-owner-id") ?? "", repoId, oid)}`
      : authorization;
    objects.push({ oid, size, authenticated: true, actions: {
      upload: multipart ? {
        href: uploadHref,
        header: { Authorization: transferAuthorization },
        expires_in: Math.floor(MULTIPART_RESERVATION_MS / 1000),
      } : {
        href: uploadHref,
        header: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(size),
          "x-amz-checksum-sha256": checksumBase64(oid),
        },
        expires_in: LFS_ACTION_SECONDS,
      },
      verify: {
        href: verifyHref,
        header: { Authorization: transferAuthorization },
        expires_in: LFS_ACTION_SECONDS,
      },
    } });
  }
  return lfsResponse({ transfer: customTransfer ? "beutl-r2-multipart" : "basic", objects });
}

export async function handleLfsVerify(
  request: Request,
  bucket: GitR2Bucket,
  storage: GitDurableStorage,
  repoId: string,
  oid: string,
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
  if (!await hasVerifiedObject(bucket, repoId, oid, record)) {
    return lfsResponse({ message: "LFS size or SHA-256 verification failed" }, 422);
  }
  if (!record.verified) await storage.put(key, { ...record, verified: true });
  return lfsResponse({ oid, size: record.size });
}
