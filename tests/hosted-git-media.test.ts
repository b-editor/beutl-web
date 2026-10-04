import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runWithDbProvider } from "@beutl/db";
import { api } from "@beutl/api";
import { GitRepositoryDurableObject } from "../packages/api/src/git/repo-durable-object";
import { gitRepositoryObject } from "../packages/api/src/git/environment";
import { appendTusUpload, createTusUpload, downloadLfsObject, readTusUpload, verifyLfsUpload, type LfsObject } from "../packages/api/src/git/media-worker";
import { basicCredential, gitAccessTokenDelegate, gitAccessTokenFixture } from "./stubs/git-access-tokens";
import { type GitDurableStorage, type LfsRecord, lfsKey, MAX_LFS_OBJECT_BYTES } from "../packages/api/src/git/lfs";

const repoId = "12345678-1234-1234-1234-123456789abc";
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
const checksum = (hex: string) => Buffer.from(hex, "hex").toString("base64");
class Bucket {
  versions = new Map<string, { key: string; bytes: Uint8Array; size: number; checksum?: string }>();
  parts = new Map<number, Uint8Array>(); uploads = 0; deletes = 0; completions = 0;
  failNextCompletion = false;
  pruned: string[][] = [];
  presigned: { key: string; size: number; sha256: string; expiresIn: number }[] = [];
  async presignUpload(key: string, size: number, sha256: string, expiresIn: number) {
    this.presigned.push({ key, size, sha256, expiresIn });
    return `https://b2.test/${key}?size=${size}&sha256=${sha256}`;
  }
  /** Emulates B2 enforcing the presigned length and the client's x-amz-checksum-sha256 header. */
  presignedPut(url: string, header: Record<string, string>, bytes: Uint8Array) {
    const target = new URL(url);
    const sha256 = target.searchParams.get("sha256")!;
    if (bytes.length !== Number(target.searchParams.get("size"))) return 403;
    if (header["x-amz-checksum-sha256"] !== checksum(sha256)) return 403;
    if (hash(bytes) !== sha256) return 400;
    this.versions.set(`put-${this.versions.size + 1}`, { key: target.pathname.slice(1), bytes, size: bytes.length, checksum: checksum(sha256) });
    return 200;
  }
  async createMultipartUpload(key: string) { return this.resumeMultipartUpload(key, "upload-1"); }
  resumeMultipartUpload(key: string, uploadId: string) {
    return { uploadId, uploadPart: async (partNumber: number, stream: ReadableStream, length: number) => {
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      expect(bytes.length).toBe(length); this.uploads++; this.parts.set(partNumber, bytes);
      return { partNumber, etag: `etag-${partNumber}` };
    }, complete: async () => {
      if (this.failNextCompletion) { this.failNextCompletion = false; throw new Error("B2 completion response lost"); }
      this.completions++;
      const size = [...this.parts.values()].reduce((n, bytes) => n + bytes.length, 0);
      const bytes = new Uint8Array(size); let offset = 0;
      for (const part of this.parts.values()) { bytes.set(part, offset); offset += part.length; }
      this.versions.set("version-1", { key, bytes, size });
      return { size, versionId: "version-1" };
    }, abort: async () => { this.parts.clear(); } };
  }
  async head(key: string, versionId?: string, options?: { checksum?: boolean }) {
    const id = versionId ?? [...this.versions].filter(([, v]) => v.key === key).at(-1)?.[0];
    const entry = id ? this.versions.get(id) : undefined;
    return entry ? { size: entry.size, versionId: id, ...(options?.checksum ? { checksumSha256: entry.checksum } : {}) } : null;
  }
  async put(key: string, bytes: Uint8Array) { this.versions.set(`put-${this.versions.size + 1}`, { key, bytes, size: bytes.length }); }
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
    extendLfs: vi.fn(async () => undefined), releaseLfs: vi.fn(async () => undefined),
    releaseRepository: vi.fn(async () => undefined) };
  const durable = new GitRepositoryDurableObject({ storage }, {}, bucket as never, accounting as never);
  const bodies: number[] = [];
  const repository = gitRepositoryObject({ BEUTL_GIT_REPOSITORIES: { idFromName: (name) => name, get: () => ({ fetch: async (r: Request) => {
    if (r.body) bodies.push((await r.clone().text()).length);
    return durable.fetch(r);
  } }) } }, repoId);
  const access = { repoId, ownerId: "owner", scope: "write" as const };
  const object = (oid: string): LfsObject => ({ bucket: bucket as never, repository, access, oid });
  async function reserve(oid: string, size: number) {
    const r = await repository.forward(new Request(`https://beutl.test/api/v3/git/${repoId}.git/info/lfs/objects/batch`, {
      method: "POST", headers: { Authorization: "Basic client-credential" },
      body: JSON.stringify({ operation: "upload", transfers: ["beutl-tus"], objects: [{ oid, size }] }),
    }), access);
    expect(r.status).toBe(200);
    const batch = await r.json();
    expect(batch.transfer).toBe("beutl-tus");
    // The client's own repository credential authorizes the transfer.
    expect(batch.objects[0].actions.upload.header).toEqual({ Authorization: "Basic client-credential" });
    const base = `https://beutl.test/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/tus`;
    const created = await createTusUpload(new Request(base, { method: "POST", headers: {
      "Tus-Resumable": "1.0.0", "Upload-Length": String(size),
    } }), object(oid));
    expect(created.status).toBe(201);
    const record = await storage.get<LfsRecord>(`lfs:${oid}`);
    return { url: created.headers.get("location")!, record: record! };
  }
  async function transfer(url: string, oid: string, resource: string, offset: number, bytes?: Uint8Array) {
    const request = new Request(url, { method: bytes ? "PATCH" : "HEAD", headers: {
      "Tus-Resumable": "1.0.0", ...(bytes ? { "Upload-Offset": String(offset), "Content-Length": String(bytes.length),
        "Content-Type": "application/offset+octet-stream" } : {}),
    }, ...(bytes ? { body: bytes } : {}) });
    return bytes ? appendTusUpload(request, object(oid), resource) : readTusUpload(object(oid), resource);
  }
  async function batch(body: unknown) {
    const r = await repository.forward(new Request(`https://beutl.test/api/v3/git/${repoId}.git/info/lfs/objects/batch`, {
      method: "POST", headers: { Authorization: "Basic client-credential" }, body: JSON.stringify(body),
    }), access);
    return { status: r.status, body: await r.json() };
  }
  const verify = (oid: string, body: unknown) => verifyLfsUpload(new Request(
    `https://beutl.test/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/verify`, {
      method: "POST", headers: { "Content-Type": "application/vnd.git-lfs+json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }), object(oid));
  return { storage, bucket, accounting, durable, object, reserve, transfer, bodies, batch, verify };
}
describe("Worker media transfers and durable metadata", () => {
  it("uploads, verifies and streams a pinned version with Range and If-Range", async () => {
    const f = fixture(), bytes = new TextEncoder().encode("a private video"), oid = hash(bytes);
    const { url, record } = await f.reserve(oid, bytes.length);
    const uploaded = await f.transfer(url, oid, record.resourceId, 0, bytes);
    expect(uploaded.status).toBe(204); expect(uploaded.headers.get("upload-verified")).toBe("true");
    expect(f.accounting.commitLfs).toHaveBeenCalledOnce();
    f.bucket.versions.set("unreferenced-newer", { key: lfsKey(repoId, oid), bytes: new Uint8Array([9]), size: 1 });
    const download = (range?: string, ifRange?: string, method = "GET") => downloadLfsObject(new Request(url, {
      method, headers: { ...(range ? { Range: range } : {}), ...(ifRange ? { "If-Range": ifRange } : {}) },
    }), f.object(oid));
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
    // The digest is checked before B2 assembles the parts, so nothing was published.
    expect(f.bucket.completions).toBe(0);
    expect(f.bucket.parts.size).toBe(0);
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
  it("continues the SHA-256 across PATCH requests and never reads stored bytes back", async () => {
    const f = fixture(), bytes = Uint8Array.from({ length: 10 * 1024 ** 2 + 77 }, (_, i) => i * 31 % 251), oid = hash(bytes);
    const { url, record } = await f.reserve(oid, bytes.length);
    // Part sizes that are not multiples of the SHA-256 block keep a tail in the stored state.
    const cut = 5 * 1024 ** 2 + 13;
    const first = await f.transfer(url, oid, record.resourceId, 0, bytes.slice(0, cut));
    expect(first.headers.get("upload-verified")).toBe("false");
    const stored = (await f.storage.get<LfsRecord>(`lfs:${oid}`))!;
    expect(stored.offset).toBe(cut);
    expect(atob(stored.hash!.tail)).toHaveLength(cut % 64);
    const last = await f.transfer(url, oid, record.resourceId, cut, bytes.slice(cut));
    expect(last.status).toBe(204);
    expect(last.headers.get("upload-verified")).toBe("true");
    expect(await f.storage.get(`lfs:${oid}`)).toMatchObject({ verified: true, versionId: "version-1", digest: oid });
    expect(f.bucket.completions).toBe(1);
    expect(f.accounting.commitLfs).toHaveBeenCalledOnce();
  });
  it("publishes after a lost completion response when the client asks for the offset", async () => {
    const f = fixture(), bytes = new TextEncoder().encode("lost completion"), oid = hash(bytes);
    const { url, record } = await f.reserve(oid, bytes.length);
    f.bucket.failNextCompletion = true;
    await expect(f.transfer(url, oid, record.resourceId, 0, bytes)).rejects.toThrow();
    expect(await f.storage.get(`lfs:${oid}`)).toMatchObject({ offset: bytes.length, verified: false, digest: oid });
    const head = await f.transfer(url, oid, record.resourceId, 0);
    expect(head.headers.get("upload-verified")).toBe("true");
    expect(f.accounting.commitLfs).toHaveBeenCalledOnce();
  });
  it("keeps the reservation of an upload that is still making progress", async () => {
    const f = fixture(), bytes = Uint8Array.from({ length: 10 * 1024 ** 2 }, (_, i) => i % 199), oid = hash(bytes);
    const { url, record } = await f.reserve(oid, bytes.length);
    await f.transfer(url, oid, record.resourceId, 0, bytes.slice(0, 5 * 1024 ** 2));
    expect(f.accounting.extendLfs).not.toHaveBeenCalled();
    // Most of the lifetime has passed, as it does for a very large upload.
    const nearlyExpired = Date.now() + 60 * 60_000;
    await f.storage.put(`lfs:${oid}`, { ...(await f.storage.get<LfsRecord>(`lfs:${oid}`))!, expiresAt: nearlyExpired });
    f.accounting.extendLfs.mockRejectedValueOnce(new Error("database unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const last = await f.transfer(url, oid, record.resourceId, 5 * 1024 ** 2, bytes.slice(5 * 1024 ** 2));
    error.mockRestore();
    expect(last.headers.get("upload-verified")).toBe("true");
    const stored = (await f.storage.get<LfsRecord>(`lfs:${oid}`))!;
    expect(stored.expiresAt).toBeGreaterThan(nearlyExpired + 22 * 60 * 60_000);
    expect(f.accounting.extendLfs).toHaveBeenCalledWith(repoId, oid, stored.expiresAt);
  });
  it("needs the 10,000th part to finish the upload", async () => {
    const f = fixture(), size = 10_000 * 5 * 1024 ** 2 + 1, oid = "e".repeat(64);
    const { url, record } = await f.reserve(oid, size);
    const offset = size - 5 * 1024 ** 2 - 1;
    await f.storage.put(`lfs:${oid}`, { ...record, offset, partCount: 9_999 });
    const short = await f.transfer(url, oid, record.resourceId, offset, new Uint8Array(5 * 1024 ** 2));
    expect(short.status).toBe(400);
    expect(await short.text()).toBe("The upload needs larger parts to fit in 10,000");
    expect(f.bucket.uploads).toBe(0);
  });
  it("finishes empty files when they are created and preserves earlier alarms", async () => {
    const f = fixture(), oid = hash(new Uint8Array());
    f.storage.alarm = Date.now() + 1000; const earlier = f.storage.alarm;
    const { url, record } = await f.reserve(oid, 0);
    expect(record).toMatchObject({ verified: true, versionId: "put-1" });
    expect(f.accounting.commitLfs).toHaveBeenCalledOnce();
    expect(f.storage.alarm).toBe(earlier);
    expect((await f.transfer(url, oid, record.resourceId, 0)).headers.get("upload-verified")).toBe("true");
    const other = fixture(), wrong = "f".repeat(64);
    await other.batch({ operation: "upload", transfers: ["beutl-tus"], objects: [{ oid: wrong, size: 0 }] });
    const created = await createTusUpload(new Request(`https://beutl.test/api/v3/git/${repoId}.git/info/lfs/objects/${wrong}/tus`, {
      method: "POST", headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "0" } }), other.object(wrong));
    expect(created.status).toBe(422);
    expect(await other.storage.get(`lfs:${wrong}`)).toBeUndefined();
  });
  it("requires a write access token for tus uploads", async () => {
    const oid = "b".repeat(64);
    const read = await gitAccessTokenFixture({ repoId, scope: "read" });
    const write = await gitAccessTokenFixture({ repoId, scope: "write" });
    const elsewhere = await gitAccessTokenFixture({ repoId: "87654321-4321-4321-4321-cba987654321" });
    const moved = await gitAccessTokenFixture({ repoId, repository: { ownerId: "new-owner", deletedAt: null } });
    const env = { BEUTL_GIT_ENABLED: "true",
      BEUTL_S3_ENDPOINT: "https://s3.us-east-005.backblazeb2.com/", BEUTL_S3_REGION: "us-east-005",
      BEUTL_S3_BUCKET: "beutl-test", BEUTL_S3_ACCESS_KEY_ID: "test", BEUTL_S3_SECRET_ACCESS_KEY: "test",
      BEUTL_GIT_REPOSITORIES: { idFromName: (v: string) => v, get: vi.fn() } };
    const db = { gitAccessToken: gitAccessTokenDelegate([read.row, write.row, elsewhere.row, moved.row]) };
    await runWithDbProvider(async () => db as never, async () => {
      const url = `https://beutl.test/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/tus`;
      const send = (token: string) => api.fetch(new Request(url, { method: "POST",
        headers: { Authorization: basicCredential(token), "Tus-Resumable": "1.0.0" } }), env);
      const readOnly = await send(read.token);
      expect(readOnly.status).toBe(403);
      expect(readOnly.headers.get("tus-resumable")).toBe("1.0.0");
      expect((await send(elsewhere.token)).status).toBe(401);
      // A token stops working once its repository changes owner.
      expect((await send(moved.token)).status).toBe(404);
      expect(env.BEUTL_GIT_REPOSITORIES.get).not.toHaveBeenCalled();
    });
  });
});

describe("Stock Git LFS basic transfers", () => {
  it("presigns a length- and checksum-bound B2 PUT and publishes it once verified", async () => {
    const f = fixture(), bytes = new TextEncoder().encode("a stock git-lfs upload"), oid = hash(bytes);
    const reserved = await f.batch({ operation: "upload", transfers: ["lfs-standalone-file", "basic", "ssh"],
      objects: [{ oid, size: bytes.length }] });
    expect(reserved.status).toBe(200);
    expect(reserved.body.transfer).toBe("basic");
    const [entry] = reserved.body.objects;
    expect(entry.authenticated).toBe(true);
    expect(entry.actions.upload.header).toEqual({ "x-amz-checksum-sha256": checksum(oid) });
    expect(entry.actions.verify).toMatchObject({ header: { Authorization: "Basic client-credential" },
      href: `https://beutl.test/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/verify` });
    expect(f.bucket.presigned).toEqual([{ key: lfsKey(repoId, oid), size: bytes.length, sha256: oid, expiresIn: 3600 }]);
    expect(Date.parse(entry.actions.upload.expires_at) - Date.now()).toBeLessThanOrEqual(3600_000);
    expect(f.accounting.reserveLfs).toHaveBeenCalledOnce();

    // Verification before the PUT finds nothing to publish.
    expect((await f.verify(oid, { oid, size: bytes.length })).status).toBe(404);
    expect(f.bucket.presignedPut(entry.actions.upload.href, entry.actions.upload.header, bytes)).toBe(200);
    expect((await f.verify(oid, { oid, size: bytes.length })).status).toBe(200);
    expect(await f.storage.get(`lfs:${oid}`)).toMatchObject({ verified: true, versionId: "put-1" });
    expect((await f.verify(oid, { oid, size: bytes.length })).status).toBe(200);
    expect(f.accounting.commitLfs).toHaveBeenCalledOnce();

    const again = await f.batch({ operation: "upload", objects: [{ oid, size: bytes.length }] });
    expect(again.body.objects).toEqual([{ oid, size: bytes.length }]);
    const download = (await f.batch({ operation: "download", objects: [{ oid, size: bytes.length }] })).body.objects[0];
    expect(await (await downloadLfsObject(new Request(download.actions.download.href), f.object(oid))).text())
      .toBe("a stock git-lfs upload");
  });
  it("publishes only an object B2 stored with the reserved length and SHA-256", async () => {
    const f = fixture(), bytes = new Uint8Array([1, 2, 3]), oid = hash(bytes);
    const [entry] = (await f.batch({ operation: "upload", objects: [{ oid, size: 3 }] })).body.objects;
    expect(f.bucket.presignedPut(entry.actions.upload.href, entry.actions.upload.header, new Uint8Array([1, 2, 3, 4]))).toBe(403);
    expect(f.bucket.presignedPut(entry.actions.upload.href, entry.actions.upload.header, new Uint8Array([3, 2, 1]))).toBe(400);
    // A tus multipart completion at the same key has no stored checksum.
    f.bucket.versions.set("version-1", { key: lfsKey(repoId, oid), bytes, size: 3 });
    const unverified = await f.verify(oid, { oid, size: 3 });
    expect(unverified.status).toBe(404);
    expect(unverified.headers.get("content-type")).toBe("application/vnd.git-lfs+json");
    expect(await unverified.json()).toEqual({ message: "LFS object has not been uploaded" });
    expect((await f.verify(oid, { oid, size: 4 })).status).toBe(422);
    expect((await f.verify(oid, { oid: "f".repeat(64), size: 3 })).status).toBe(422);
    expect((await f.verify(oid, "{")).status).toBe(400);
    expect(f.accounting.commitLfs).not.toHaveBeenCalled();
    expect(await f.storage.get(`lfs:${oid}`)).toMatchObject({ verified: false });
    await f.storage.put(`lfs:${oid}`, { ...(await f.storage.get<LfsRecord>(`lfs:${oid}`))!, expiresAt: Date.now() - 1 });
    expect((await f.verify(oid, { oid, size: 3 })).status).toBe(410);
  });
  it("leaves objects over 5 GB to the desktop agent and limits every object to 10,000 parts of 32 MiB", async () => {
    const f = fixture();
    const objects = [{ oid: "a".repeat(64), size: 5_000_000_000 }, { oid: "b".repeat(64), size: 5_000_000_001 },
      { oid: "c".repeat(64), size: MAX_LFS_OBJECT_BYTES + 1 }];
    const basic = await f.batch({ operation: "upload", objects });
    expect(basic.body.objects[0].actions.upload.href).toMatch(/^https:\/\/b2\.test\//u);
    expect(basic.body.objects.slice(1)).toEqual([
      { ...objects[1], error: { code: 422, message: "LFS objects over 5 GB need the Beutl desktop app" } },
      { ...objects[2], error: { code: 422, message: "LFS objects are limited to 312.5 GiB" } },
    ]);
    expect(f.accounting.reserveLfs).toHaveBeenCalledOnce();
    // Only the account quota bounds a repository's total; two objects may exceed the old 20 GiB cap.
    const largest = [{ oid: "1".repeat(64), size: MAX_LFS_OBJECT_BYTES }, { oid: "2".repeat(64), size: MAX_LFS_OBJECT_BYTES }];
    const agent = await fixture().batch({ operation: "upload", transfers: ["basic", "beutl-tus"], objects: largest });
    expect(agent.body.transfer).toBe("beutl-tus");
    for (const [i, entry] of agent.body.objects.entries()) {
      expect(entry.actions.upload.href).toMatch(/\/tus$/u);
      expect(entry.actions.verify.href).toMatch(new RegExp(`${largest[i].oid}/verify$`, "u"));
    }
    // Pushing a commit that references media the desktop already stored needs no transfer.
    await f.storage.put(`lfs:${objects[1].oid}`, { size: objects[1].size, expiresAt: 0, verified: true,
      resourceId: crypto.randomUUID(), versionId: "version-1", offset: objects[1].size, partCount: 1 });
    expect((await f.batch({ operation: "upload", objects: [objects[1]] })).body.objects).toEqual([objects[1]]);
  });
  it("refuses transfers it cannot serve and never presigns past the reservation", async () => {
    const f = fixture(), oid = "d".repeat(64);
    expect((await f.batch({ operation: "upload", transfers: ["tus"], objects: [{ oid, size: 1 }] })).status).toBe(422);
    expect(f.accounting.reserveLfs).not.toHaveBeenCalled();
    await f.batch({ operation: "upload", objects: [{ oid, size: 1 }] });
    const record = (await f.storage.get<LfsRecord>(`lfs:${oid}`))!;
    await f.storage.put(`lfs:${oid}`, { ...record, expiresAt: Date.now() + 120_000 });
    const [entry] = (await f.batch({ operation: "upload", objects: [{ oid, size: 1 }] })).body.objects;
    expect(f.bucket.presigned.at(-1)!.expiresIn).toBeGreaterThanOrEqual(119);
    expect(f.bucket.presigned.at(-1)!.expiresIn).toBeLessThanOrEqual(120);
    expect(Date.parse(entry.actions.upload.expires_at)).toBeLessThanOrEqual(Date.now() + 120_000);
  });
});
