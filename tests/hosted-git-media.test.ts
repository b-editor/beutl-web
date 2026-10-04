import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runWithDbProvider } from "@beutl/db";
import { GitRepositoryDurableObject } from "../packages/api/src/git/repo-durable-object";
import { handleLfsDownload, handleTusWorker } from "../packages/api/src/git/media-worker";
import { issueGitToken, issueUploadToken } from "../packages/api/src/git/tokens";
import { routeGitRequest } from "../packages/api/src/git/router";
import { type GitDurableStorage, type LfsRecord, lfsKey } from "../packages/api/src/git/lfs";

const repoId = "12345678-1234-1234-1234-123456789abc";
const secret = "hosted-git-test-secret-for-scoped-jwts";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
class Storage implements GitDurableStorage {
  values = new Map<string, any>(); alarm: number | null = null;
  async get<T>(key: string) { return structuredClone(this.values.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.values.set(key, structuredClone(value)); }
  async delete(key: string | string[]) { for (const k of Array.isArray(key) ? key : [key]) this.values.delete(k); }
  async list<T>({ prefix, startAfter, limit = Infinity }: { prefix: string; startAfter?: string; limit?: number }) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)) as Map<string, T>;
  }
  async getAlarm() { return this.alarm; }
  async setAlarm(time: number) { this.alarm = time; }
}
class Bucket {
  versions = new Map<string, { key: string; bytes: Uint8Array; size: number }>();
  parts = new Map<number, Uint8Array>(); reads = 0; uploads = 0; deletes = 0;
  virtualSize?: number;
  pruned: string[][] = [];
  async createMultipartUpload(key: string) { return this.resumeMultipartUpload(key, "upload-1"); }
  resumeMultipartUpload(key: string, uploadId: string) {
    return { uploadId, uploadPart: async (partNumber: number, stream: ReadableStream, length: number) => {
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      expect(bytes.length).toBe(length); this.uploads++; this.parts.set(partNumber, bytes);
      return { partNumber, etag: `etag-${partNumber}` };
    }, complete: async () => {
      const size = [...this.parts.values()].reduce((n, bytes) => n + bytes.length, 0);
      const bytes = new Uint8Array(size); let offset = 0;
      for (const part of this.parts.values()) { bytes.set(part, offset); offset += part.length; }
      this.versions.set("version-1", { key, bytes, size: this.virtualSize ?? size });
      return { size: this.virtualSize ?? size, versionId: "version-1" };
    }, abort: async () => { this.parts.clear(); }, listParts: async () => [] };
  }
  async head(key: string, versionId?: string) {
    const entry = versionId ? this.versions.get(versionId) : [...this.versions.values()].find(v => v.key === key);
    return entry ? { size: entry.size, versionId: versionId ?? "version-1" } : null;
  }
  async getRange(key: string, versionId: string, start: number, length: number) {
    const entry = this.versions.get(versionId)!;
    expect(entry.key).toBe(key); this.reads += length;
    const bytes = entry.size === entry.bytes.length ? entry.bytes.slice(start, start + length) : new Uint8Array(length);
    return { size: entry.size, versionId, body: new Response(bytes).body! };
  }
  async download(key: string, versionId: string, method: string, range?: string) {
    const entry = this.versions.get(versionId)!; expect(entry.key).toBe(key);
    let start = 0, end = entry.bytes.length - 1, status = 200;
    if (range) {
      const [first, last] = range.slice(6).split("-");
      start = first ? Number(first) : Math.max(0, entry.bytes.length - Number(last));
      end = first && last ? Math.min(Number(last), end) : end; status = 206;
      if (start >= entry.bytes.length || end < start || (!first && last === "0"))
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${entry.size}` } });
    }
    const bytes = entry.bytes.slice(start, end + 1);
    return new Response(method === "HEAD" ? null : bytes, { status, headers: {
      "Content-Length": String(bytes.length), ETag: '"version-1"', "Content-Type": "application/octet-stream",
      "Last-Modified": "Sat, 03 Oct 2026 10:00:00 GMT", ...(range ? { "Content-Range": `bytes ${start}-${end}/${entry.size}` } : {}),
    } });
  }
  async delete(key: string) { this.deletes++; for (const [v, entry] of this.versions) if (entry.key === key) this.versions.delete(v); }
  async cleanupMultipartUploads() { }
  async pruneVersions(_key: string, keep: string[]) { this.pruned.push(keep); }
  async list() { return { objects: [], truncated: false }; }
}
function fixture() {
  const storage = new Storage(), bucket = new Bucket();
  const accounting = { reserveLfs: vi.fn(async () => "reserved"), commitLfs: vi.fn(async () => undefined),
    releaseLfs: vi.fn(async () => undefined), releaseRepository: vi.fn(async () => undefined) };
  const durable = new GitRepositoryDurableObject({ storage }, { BEUTL_GIT_TOKEN_SECRET: secret }, bucket as never, accounting as never);
  const bodies: number[] = [];
  const stub = { fetch: async (r: Request) => {
    if (r.body) bodies.push((await r.clone().text()).length);
    return durable.fetch(r);
  } };
  const headers = new Headers({ "x-beutl-repo-id": repoId, "x-beutl-git-owner-id": "owner", "x-beutl-git-scope": "write" });
  async function reserve(oid: string, size: number) {
    const r = await durable.fetch(new Request(`https://beutl.test/api/v3/git/${repoId}.git/info/lfs/objects/batch`, {
      method: "POST", headers, body: JSON.stringify({ operation: "upload", transfers: ["beutl-tus"], objects: [{ oid, size }] }),
    }));
    expect(r.status).toBe(200); expect((await r.json()).transfer).toBe("beutl-tus");
    const base = `https://beutl.test/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/tus`;
    const created = await handleTusWorker(new Request(base, { method: "POST", headers: {
      "Tus-Resumable": "1.0.0", "Upload-Length": String(size),
    } }), bucket as never, stub, headers, repoId, oid);
    expect(created.status).toBe(201);
    const record = await storage.get<LfsRecord>(`lfs:${oid}`);
    return { url: created.headers.get("location")!, record: record! };
  }
  async function transfer(url: string, oid: string, resource: string, offset: number, bytes?: Uint8Array) {
    return handleTusWorker(new Request(url, { method: bytes ? "PATCH" : "HEAD", headers: {
      "Tus-Resumable": "1.0.0", ...(bytes ? { "Upload-Offset": String(offset), "Content-Length": String(bytes.length),
        "Content-Type": "application/offset+octet-stream" } : {}),
    }, ...(bytes ? { body: bytes } : {}) }), bucket as never, stub, headers, repoId, oid, resource);
  }
  return { storage, bucket, accounting, durable, stub, headers, reserve, transfer, bodies };
}
describe("Worker media transfers and durable metadata", () => {
  it("uploads, verifies and streams a pinned version with Range and If-Range", async () => {
    const f = fixture(), bytes = new TextEncoder().encode("a private video"), oid = hash(bytes);
    const { url, record } = await f.reserve(oid, bytes.length);
    const uploaded = await f.transfer(url, oid, record.resourceId, 0, bytes);
    expect(uploaded.status).toBe(204); expect(uploaded.headers.get("upload-verified")).toBe("true");
    expect(f.accounting.commitLfs).toHaveBeenCalledOnce();
    f.bucket.versions.set("unreferenced-newer", { key: lfsKey(repoId, oid), bytes: new Uint8Array([9]), size: 1 });
    const download = (range?: string, ifRange?: string, method = "GET") => handleLfsDownload(new Request(url, {
      method, headers: { ...(range ? { Range: range } : {}), ...(ifRange ? { "If-Range": ifRange } : {}) },
    }), f.bucket as never, f.stub, f.headers, repoId, oid);
    const response = await download("bytes=2-6");
    expect(response.status).toBe(206); expect(await response.text()).toBe("priva");
    expect(response.headers.get("content-range")).toBe(`bytes 2-6/${bytes.length}`);
    expect(response.headers.has("location")).toBe(false);
    expect((await download("bytes=-5")).status).toBe(206);
    expect((await download("bytes=999-")).status).toBe(416);
    expect((await download("bytes=0-1,4-5")).status).toBe(416);
    expect((await download("bytes=2-6", '"different"')).status).toBe(200);
    expect((await download("bytes=2-6", '"version-1"')).status).toBe(206);
    expect((await download(undefined, undefined, "HEAD")).body).toBeNull();
    expect(Math.max(...f.bodies)).toBeLessThan(1024);
    await f.durable.alarm(); expect(f.bucket.pruned).toEqual([["version-1"]]);
    await f.durable.alarm(); expect(f.bucket.pruned).toHaveLength(1);
  });
  it("rejects wrong offsets and hashes before publishing; only then releases bad data", async () => {
    const f = fixture(), bytes = new Uint8Array([1, 2, 3]), oid = hash(bytes);
    const { url, record } = await f.reserve(oid, bytes.length);
    expect((await f.transfer(url, oid, record.resourceId, 1, bytes)).status).toBe(409);
    expect(f.bucket.uploads).toBe(0);
    expect((await f.transfer(url, oid, record.resourceId, 0, new Uint8Array([3, 2, 1]))).status).toBe(422);
    expect(f.accounting.commitLfs).not.toHaveBeenCalled();
    expect(f.accounting.releaseLfs).toHaveBeenCalledOnce();
    expect(await f.storage.get(`lfs:${oid}`)).toBeUndefined();
  });
  it("recovers an accepted PATCH after its response was lost", async () => {
    const f = fixture(), bytes = new Uint8Array(5 * 1024 ** 2 + 1), oid = hash(bytes);
    const { url, record } = await f.reserve(oid, bytes.length);
    expect((await f.transfer(url, oid, record.resourceId, 0, bytes.slice(0, -1))).status).toBe(204);
    const head = await f.transfer(url, oid, record.resourceId, 0);
    expect(head.headers.get("upload-offset")).toBe(String(bytes.length - 1));
    expect((await f.transfer(url, oid, record.resourceId, 0, bytes.slice(0, -1))).status).toBe(409);
    expect((await f.transfer(url, oid, record.resourceId, bytes.length - 1, bytes.slice(-1))).headers.get("upload-verified")).toBe("true");
  });
  it("resumes a virtual 5 GiB + 1 upload and checkpoints verification without reading its entire prefix", async () => {
    const f = fixture(), size = 5 * 1024 ** 3 + 1, oid = "a".repeat(64);
    f.bucket.virtualSize = size;
    const { url, record } = await f.reserve(oid, size);
    await f.storage.put(`lfs:${oid}`, { ...record, offset: size - 1, partCount: 160 });
    const patched = await f.transfer(url, oid, record.resourceId, size - 1, new Uint8Array([0]));
    expect(patched.headers.get("upload-offset")).toBe(String(size));
    expect(patched.headers.get("upload-verified")).toBe("false");
    expect((await f.storage.get<LfsRecord>(`lfs:${oid}`))!.checkpoint!.offset).toBe(32 * 1024 ** 2);
    await f.transfer(url, oid, record.resourceId, size);
    expect((await f.storage.get<LfsRecord>(`lfs:${oid}`))!.checkpoint!.offset).toBe(64 * 1024 ** 2);
    expect(f.bucket.reads).toBe(64 * 1024 ** 2);
    expect(f.accounting.commitLfs).not.toHaveBeenCalled();
  });
  it("handles empty files and preserves earlier alarms", async () => {
    const f = fixture(), oid = hash(new Uint8Array());
    f.storage.alarm = Date.now() + 1000; const earlier = f.storage.alarm;
    const { url, record } = await f.reserve(oid, 0);
    expect(f.storage.alarm).toBe(earlier);
    expect((await f.transfer(url, oid, record.resourceId, 0)).headers.get("upload-verified")).toBe("true");
  });
  it("binds upload credentials to repository, OID and reservation expiry", async () => {
    const now = Date.now(), oid = "b".repeat(64);
    const token = await issueUploadToken(secret, "owner", repoId, oid, now + 15_000);
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    expect(payload.exp * 1000).toBeLessThanOrEqual(now + 15_000);
    const env = { BEUTL_GIT_ENABLED: "true", BEUTL_GIT_TOKEN_SECRET: secret,
      BEUTL_S3_ENDPOINT: "https://s3.us-east-005.backblazeb2.com/", BEUTL_S3_REGION: "us-east-005",
      BEUTL_S3_BUCKET: "beutl-test", BEUTL_S3_ACCESS_KEY_ID: "test", BEUTL_S3_SECRET_ACCESS_KEY: "test",
      BEUTL_GIT_REPOSITORIES: { idFromName: (v: string) => v, get: vi.fn() } };
    const read = (await issueGitToken(secret, "owner", repoId, "read")).token;
    const db = { gitRepository: { findFirst: async () => null } };
    await runWithDbProvider(async () => db as never, async () => {
      const url = `https://beutl.test/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/tus`;
      expect((await routeGitRequest(new Request(url, { headers: { Authorization: `Bearer ${read}` } }), env))!.status).toBe(401);
      expect((await routeGitRequest(new Request(url.replace(oid, "c".repeat(64)), {
        headers: { Authorization: `Bearer ${token}` },
      }), env))!.status).toBe(401);
      expect((await routeGitRequest(new Request(url, { headers: { Authorization: `Bearer ${token}`,
        "x-beutl-git-owner-id": "owner", "x-beutl-git-scope": "write" } }), env))!.status).toBe(404);
      expect(env.BEUTL_GIT_REPOSITORIES.get).not.toHaveBeenCalled();
    });
  });
});
