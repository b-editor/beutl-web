import type { GitObjectBucket } from "./git-object-store";
import type { GitStorageAccounting } from "./accounting";
import type { Sha256Checkpoint } from "./checkpoint-sha256";
import { readBodyAtMost } from "./git-http";
import { gitTokenSecret, issueUploadToken, type GitScope } from "./tokens";

export const MAX_LFS_OBJECT_BYTES = 20 * 1024 ** 3;
export const MIN_TUS_PART_BYTES = 5 * 1024 ** 2;
export const UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;
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
  offset: number; partCount: number; checkpoint?: Sha256Checkpoint;
  lease?: { id: string; until: number; offset: number; length: number };
}
export type LfsPart = { partNumber: number; etag: string };
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
  request: Request, bucket: GitObjectBucket, storage: GitDurableStorage,
  env: { BEUTL_GIT_TOKEN_SECRET?: string }, repoId: string, scope: GitScope,
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
        !Number.isSafeInteger(o.size) || o.size < 0 || o.size > MAX_LFS_OBJECT_BYTES))
    return json({ message: "Invalid LFS batch" }, 400);
  if (input.operation === "upload" && scope !== "write") return json({ message: "Forbidden" }, 403);
  if (input.operation === "upload" && !input.transfers?.includes("beutl-tus"))
    return json({ message: "Uploads require the beutl-tus transfer agent" }, 422);
  const ownerId = request.headers.get("x-beutl-git-owner-id") ?? "";
  const base = `${new URL(request.url).origin}/api/v3/git/${repoId}.git/info/lfs/objects`;
  const objects = [];
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
          href: `${base}/${oid}/download`, header: { Authorization: request.headers.get("authorization") },
        } } }
        : { oid, size, error: { code: 404, message: "LFS object is not verified" } });
      continue;
    }
    if (record?.verified) { objects.push({ oid, size }); continue; }
    if (!record) {
      const records = await storage.list<LfsRecord>({ prefix: "lfs:" });
      const used = [...records.values()].reduce((n, r) => n + r.size, 0);
      const expiresAt = Date.now() + UPLOAD_LIFETIME_MS;
      if (records.size >= 10_000 || used + size > MAX_LFS_OBJECT_BYTES ||
          await accounting?.reserveLfs({ repoId, oid, ownerId, size, expiresAt }) === "overQuota") {
        objects.push({ oid, size, error: { code: 413, message: "Account storage quota exceeded" } }); continue;
      }
      record = { size, expiresAt, verified: false, resourceId: crypto.randomUUID(), offset: 0, partCount: 0 };
      await storage.put(`lfs:${oid}`, record);
      await scheduleGitMaintenance(storage, expiresAt + 1000);
    }
    const token = await issueUploadToken(gitTokenSecret(env), ownerId, repoId, oid, record.expiresAt);
    objects.push({ oid, size, authenticated: true, actions: { upload: {
      href: `${base}/${oid}/tus`, header: { Authorization: `Bearer ${token}` },
      expires_at: new Date(record.expiresAt).toISOString(),
    } } });
  }
  return new Response(JSON.stringify({ transfer: input.transfers?.includes("beutl-tus") ? "beutl-tus" : "basic", objects }), {
    headers: { "Content-Type": "application/vnd.git-lfs+json", "Cache-Control": "no-store" },
  });
}
