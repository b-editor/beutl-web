import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { handleLfsBatch, handleLfsVerify, type GitDurableStorage, type LfsRecord } from "../packages/api/src/git/lfs";
import { handleMultipart } from "../packages/api/src/git/multipart";
import { GitRepositoryDurableObject } from "../packages/api/src/git/repo-durable-object";
import { GitObjectStore, type GitObjectBucket, type GitMultipartUpload } from "../packages/api/src/git/git-object-store";
import { issueGitToken, issueMultipartToken, verifyGitToken, verifyMultipartToken } from "../packages/api/src/git/tokens";
import { apiRequestBodyLimit, MAX_API_JSON_REQUEST_BYTES } from "../packages/core/src/request-body-limit";
import { setDbProvider } from "../packages/db/src/provider";
import {
  GIT_DELETE_SWEEP_GRACE_MS,
  reconcileGitRepositoryDeletions,
  routeGitRequest,
} from "../packages/api/src/git/router";

const repoId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const secret = "hosted-git-test-secret-with-32-or-more-characters";
const env = {
  BEUTL_GIT_TOKEN_SECRET: secret,
  BEUTL_GIT_S3_ENDPOINT: "https://s3.us-east-005.backblazeb2.com/",
  BEUTL_GIT_S3_REGION: "us-east-005",
  BEUTL_GIT_S3_BUCKET: "git-test",
  BEUTL_GIT_S3_ACCESS_KEY_ID: "test-key",
  BEUTL_GIT_S3_SECRET_ACCESS_KEY: "test-secret",
  BEUTL_GIT_LFS_REPO_QUOTA_BYTES: String(6 * 1024 ** 3),
};

class MemoryStorage implements GitDurableStorage {
  values = new Map<string, unknown>();
  alarms: number[] = [];
  async get<T>(key: string) { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T) { this.values.set(key, value); }
  async delete(key: string) { return this.values.delete(key); }
  async list<T>({ prefix }: { prefix: string }) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix))) as Map<string, T>;
  }
  async setAlarm(time: number) { this.alarms.push(time); }
}

class MemoryBucket implements GitObjectBucket {
  objects = new Map<string, Uint8Array>();
  uploads = new Map<string, Map<number, Uint8Array>>();
  onGet?: () => Promise<void>;
  async get(key: string, _versionId?: string) {
    await this.onGet?.();
    const data = this.objects.get(key);
    if (!data) return null;
    return {
      size: data.byteLength,
      versionId: "test-v1",
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } }),
      arrayBuffer: async () => Uint8Array.from(data).buffer,
    };
  }
  async put(key: string, value: Uint8Array) { this.objects.set(key, Uint8Array.from(value)); }
  async delete(key: string | string[]) { for (const item of Array.isArray(key) ? key : [key]) this.objects.delete(item); }
  async head(key: string, _versionId?: string) {
    const data = this.objects.get(key);
    if (!data) return null;
    return {
      size: data.byteLength,
      versionId: "test-v1",
    };
  }
  async list({ prefix, delimiter, cursor, limit }: { prefix: string; delimiter?: string; cursor?: string; limit: number }) {
    const entries = new Map<string, "object" | "prefix">();
    for (const key of this.objects.keys()) {
      if (!key.startsWith(prefix)) continue;
      const suffix = key.slice(prefix.length);
      const separator = delimiter ? suffix.indexOf(delimiter) : -1;
      entries.set(separator >= 0 ? prefix + suffix.slice(0, separator + 1) : key,
        separator >= 0 ? "prefix" : "object");
    }
    const keys = [...entries.keys()].sort();
    const start = cursor ? keys.findIndex((key) => key > cursor) : 0;
    const page = keys.slice(Math.max(start, 0), Math.max(start, 0) + limit);
    return {
      objects: page.filter((key) => entries.get(key) === "object")
        .map((key) => ({ key, size: this.objects.get(key)!.byteLength })),
      truncated: page.length > 0 && keys.indexOf(page.at(-1)!) < keys.length - 1,
      cursor: page.at(-1),
      delimitedPrefixes: page.filter((key) => entries.get(key) === "prefix"),
    };
  }
  async createMultipartUpload(key: string) {
    const uploadId = `${key}:${this.uploads.size}`;
    this.uploads.set(uploadId, new Map());
    return this.resumeMultipartUpload(key, uploadId);
  }
  resumeMultipartUpload(key: string, uploadId: string): GitMultipartUpload {
    return {
      uploadId,
      uploadPart: async (partNumber, stream, _length) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        const data = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
        this.uploads.get(uploadId)!.set(partNumber, data);
        return { partNumber, etag: createHash("md5").update(data).digest("hex") };
      },
      listParts: async () => [...(this.uploads.get(uploadId) ?? new Map()).entries()]
        .map(([partNumber, data]) => ({ partNumber, etag: createHash("md5").update(data).digest("hex"), size: data.byteLength })),
      complete: async (parts) => {
        const chunks = parts.map((part) => this.uploads.get(uploadId)!.get(part.partNumber)!);
        const data = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
        this.objects.set(key, data);
        this.uploads.delete(uploadId);
        return { size: data.length, versionId: "test-v1" };
      },
      abort: async () => { this.uploads.delete(uploadId); },
    };
  }
  async presignPut(key: string) { return `https://s3.us-east-005.backblazeb2.com/git-test/${key}?X-Amz-Signature=test`; }
  async presignGet(key: string, versionId: string) {
    return `https://s3.us-east-005.backblazeb2.com/git-test/${key}?versionId=${versionId}&X-Amz-Signature=test`;
  }
}

class CountingBucket extends MemoryBucket {
  bytesReceived = 0;
  accepted = new Map<number, { partNumber: number; etag: string; size: number }>();
  override resumeMultipartUpload(key: string, uploadId: string): GitMultipartUpload {
    const base = super.resumeMultipartUpload(key, uploadId);
    return {
      ...base,
      uploadPart: async (partNumber, body, _length) => {
        let size = 0;
        for await (const chunk of body) { this.bytesReceived += chunk.byteLength; size += chunk.byteLength; }
        this.accepted.set(partNumber, { partNumber, etag: "counted", size });
        return { partNumber, etag: "counted" };
      },
      listParts: async () => [...this.accepted.values()],
    };
  }
}

function lfsRequest(operation: "upload" | "download", objects: { oid: string; size: number }[], transfers = ["basic"]) {
  return new Request(`https://beutl.beditor.net/api/v3/git/${repoId}.git/info/lfs/objects/batch`, {
    method: "POST",
    body: JSON.stringify({ operation, objects, transfers }),
  });
}

describe("hosted Git token boundaries", () => {
  it("sweeps deleted repositories again after signed PUT URLs expire", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    const row: { id: string; deletedAt: Date; cleanupCompleteAt: Date | null } = {
      id: repoId, deletedAt: new Date(), cleanupCompleteAt: null,
    };
    setDbProvider(async () => ({
      gitRepository: {
        findMany: async () => row.cleanupCompleteAt ? [] : [row],
        update: async ({ data }: { data: Partial<typeof row> }) => { Object.assign(row, data); },
      },
    }) as never);
    const routeEnv = {
      ...env, BEUTL_GIT_ENABLED: "true",
      BEUTL_GIT_REPOSITORIES: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: (request: Request) => durable.fetch(request) }),
      },
    };
    const key = `git-lfs/repos/${repoId}/aa/${"a".repeat(64)}`;
    await bucket.put(key, new Uint8Array([1]));
    expect(await reconcileGitRepositoryDeletions(routeEnv)).toBe(1);
    expect(bucket.objects.has(key)).toBe(false);
    expect(row.cleanupCompleteAt).toBeNull();

    // A direct R2 upload can arrive after the first deletion sweep.
    await bucket.put(key, new Uint8Array([2]));
    row.deletedAt = new Date(Date.now() - GIT_DELETE_SWEEP_GRACE_MS - 1);
    expect(await reconcileGitRepositoryDeletions(routeEnv)).toBe(1);
    expect(bucket.objects.has(key)).toBe(false);
    expect(row.cleanupCompleteAt).toBeInstanceOf(Date);
  });

  it("binds short Git tokens to owner, repository and scope", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token } = await issueGitToken(secret, "user-a", repoId, "read", now);
    expect(await verifyGitToken(secret, `Bearer ${token}`, repoId, "read", now + 1)).toEqual({ ownerId: "user-a", scope: "read" });
    expect(await verifyGitToken(secret, `Bearer ${token}`, repoId, "write", now + 1)).toBeNull();
    expect(await verifyGitToken(secret, `Bearer ${token}`, otherId, "read", now + 1)).toBeNull();
    expect(await verifyGitToken(secret, `Bearer ${token}`, repoId, "read", now + 3_601)).toBeNull();
  });

  it("restricts multipart sessions to one OID and repository", async () => {
    const oid = "a".repeat(64);
    const now = Math.floor(Date.now() / 1000);
    const token = await issueMultipartToken(secret, "user-a", repoId, oid, now);
    expect(await verifyMultipartToken(secret, `Bearer ${token}`, repoId, oid, now + 1)).toEqual({ ownerId: "user-a" });
    expect(await verifyMultipartToken(secret, `Bearer ${token}`, otherId, oid, now + 1)).toBeNull();
    expect(await verifyMultipartToken(secret, `Bearer ${token}`, repoId, "b".repeat(64), now + 1)).toBeNull();
    expect(await verifyGitToken(secret, `Bearer ${token}`, repoId, "write", now + 1)).toBeNull();
  });

  it("checks database ownership and replaces spoofed internal headers", async () => {
    setDbProvider(async () => ({
      gitRepository: {
        findFirst: async ({ where }: { where: { ownerId: string; id: string } }) =>
          where.ownerId === "owner-a" && where.id === repoId ? { id: repoId } : null,
      },
    }) as never);
    const bucket = new MemoryBucket();
    const routeEnv = {
      ...env, BEUTL_GIT_ENABLED: "true",
      BEUTL_GIT_REPOSITORIES: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async (request: Request) => Response.json({
          scope: request.headers.get("x-beutl-git-scope"),
          owner: request.headers.get("x-beutl-git-owner-id"),
        }) }),
      },
    };
    const url = `https://beutl.beditor.net/api/v3/git/${repoId}.git/info/refs?service=git-upload-pack`;
    const wrong = (await issueGitToken(secret, "owner-b", repoId, "read")).token;
    expect((await routeGitRequest(new Request(url, {
      headers: { Authorization: `Bearer ${wrong}` },
    }), routeEnv))?.status).toBe(404);
    const right = (await issueGitToken(secret, "owner-a", repoId, "read")).token;
    const result = await routeGitRequest(new Request(url, {
      headers: {
        Authorization: `Bearer ${right}`,
        "x-beutl-git-scope": "admin",
        "x-beutl-git-owner-id": "owner-b",
      },
    }), routeEnv);
    expect(await result?.json()).toEqual({ scope: "read", owner: "owner-a" });
  });
});

it("allocates the larger body cap only to the Git pack and LFS part methods", () => {
  const base = `/api/v3/git/${repoId}.git`;
  expect(apiRequestBodyLimit("POST", `${base}/git-receive-pack`, "application/x-git-receive-pack-request"))
    .toBe(8 * 1024 * 1024);
  expect(apiRequestBodyLimit("POST", `${base}/git-upload-pack`, "application/x-git-upload-pack-request"))
    .toBe(64 * 1024);
  expect(apiRequestBodyLimit("PUT", `${base}/info/lfs/objects/${"a".repeat(64)}/multipart/parts/1`, "application/octet-stream"))
    .toBe(64 * 1024 * 1024);
  expect(apiRequestBodyLimit("POST", `${base}/info/lfs/objects/${"a".repeat(64)}/multipart/parts/1`, "application/octet-stream"))
    .toBe(MAX_API_JSON_REQUEST_BYTES);
});

describe("Git Smart HTTP with the native Git CLI", () => {
  it("pushes and clones a repository through the Durable Object", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    const server = createServer(async (incoming, outgoing) => {
      try {
        const address = `http://127.0.0.1:${(server.address() as { port: number }).port}${incoming.url}`;
        const headers = new Headers(incoming.headers as Record<string, string>);
        headers.set("x-beutl-repo-id", repoId);
        headers.set("x-beutl-git-scope", "write");
        const request = new Request(address, {
          method: incoming.method,
          headers,
          ...(incoming.method === "POST" ? { body: Readable.toWeb(incoming), duplex: "half" } : {}),
        } as RequestInit & { duplex?: "half" });
        const response = await durable.fetch(request);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        outgoing.writeHead(500);
        outgoing.end(String(error));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const root = mkdtempSync(join(tmpdir(), "beutl-git-http-"));
    const runGit = promisify(execFile);
    const git = async (cwd: string, ...args: string[]) => runGit("git", args, {
      cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
    });
    try {
      await git(root, "init", "-b", "main");
      writeFileSync(join(root, "project.txt"), "hello hosted git\n");
      await git(root, "add", "project.txt");
      await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com",
        "-c", "commit.gpgsign=false", "commit", "-m", "initial");
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v3/git/${repoId}.git`;
      await git(root, "remote", "add", "origin", url);
      await git(root, "push", "origin", "main");
      await git(root, "clone", url, join(root, "copy"));
      expect(readFileSync(join(root, "copy", "project.txt"), "utf8").replace(/\r\n/gu, "\n"))
        .toBe("hello hosted git\n");
      writeFileSync(join(root, "second.txt"), "pulled from origin\n");
      await git(root, "add", "second.txt");
      await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com",
        "-c", "commit.gpgsign=false", "commit", "-m", "second");
      await git(root, "push", "origin", "main");
      await git(join(root, "copy"), "pull", "--ff-only", "origin", "main");
      expect(readFileSync(join(root, "copy", "second.txt"), "utf8").replace(/\r\n/gu, "\n"))
        .toBe("pulled from origin\n");
      writeFileSync(join(root, "from-original.txt"), "one");
      writeFileSync(join(root, "copy", "from-copy.txt"), "two");
      await git(root, "add", "from-original.txt");
      await git(join(root, "copy"), "add", "from-copy.txt");
      const commitArgs = ["-c", "user.name=Test", "-c", "user.email=test@example.com",
        "-c", "commit.gpgsign=false", "commit", "-m", "concurrent"];
      await git(root, ...commitArgs);
      await git(join(root, "copy"), ...commitArgs);
      const concurrent = await Promise.allSettled([
        git(root, "push", "origin", "main"),
        git(join(root, "copy"), "push", "origin", "main"),
      ]);
      expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    } finally {
      server.close();
      if (!root.startsWith(tmpdir() + sep)) throw new Error("Test directory escaped the temporary root");
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("R2 object adapter", () => {
  it("lists all pages without dropping objects", async () => {
    const bucket = new MemoryBucket();
    for (let index = 0; index < 1_001; index++) bucket.objects.set(`key/${index.toString().padStart(4, "0")}`, new Uint8Array([index % 256]));
    expect((await new GitObjectStore(bucket).list("key/")).objects).toHaveLength(1_001);
  });
});

describe("Git LFS reservation and integrity", () => {
  it("negotiates multipart above 5 GiB, resumes metadata, and aborts", async () => {
    const bucket = new CountingBucket();
    const storage = new MemoryStorage();
    const oid = "c".repeat(64);
    const size = 5 * 1024 ** 3 + 1;
    const result = await handleLfsBatch(
      lfsRequest("upload", [{ oid, size }], ["basic", "beutl-multipart"]),
      bucket, storage, env, repoId, "write", "Bearer git-token",
    );
    const batch = await result.json();
    expect(batch.transfer).toBe("beutl-multipart");
    expect(batch.objects[0].actions.upload.href).toContain("/multipart");
    const base = batch.objects[0].actions.upload.href;
    const first = await (await handleMultipart(new Request(base, { method: "POST" }), bucket, storage, repoId, oid, "")).json();
    expect(first.partCount).toBe(81);
    let remaining = 64;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining-- > 0) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const part = await handleMultipart(new Request(`${base}/parts/1`, {
      method: "PUT", body, duplex: "half",
      headers: { "x-beutl-git-part-length": String(64 * 1024 * 1024) },
    } as RequestInit & { duplex: "half" }), bucket, storage, repoId, oid, "parts/1");
    expect(part.status).toBe(200);
    expect(bucket.bytesReceived).toBe(64 * 1024 * 1024);
    const resumed = await (await handleMultipart(new Request(base, { method: "POST" }), bucket, storage, repoId, oid, "")).json();
    expect(resumed.partCount).toBe(first.partCount);
    expect(resumed.parts).toEqual([{ partNumber: 1, etag: "counted", size: 64 * 1024 * 1024 }]);
    expect(bucket.uploads.size).toBe(1);
    expect((await handleMultipart(new Request(base, { method: "DELETE" }), bucket, storage, repoId, oid, "")).status).toBe(204);
    expect(bucket.uploads.size).toBe(0);
    expect(await storage.get(`lfs:${oid}`)).toBeUndefined();
  });

  it("does not allocate quota for a second oversized reservation", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const size = 5 * 1024 ** 3 + 1;
    const result = await handleLfsBatch(
      lfsRequest("upload", [
        { oid: "c".repeat(64), size }, { oid: "d".repeat(64), size },
      ], ["beutl-multipart"]),
      bucket, storage, env, repoId, "write", "Bearer git-token",
    );
    const batch = await result.json();
    expect(batch.objects[0].actions.upload).toBeDefined();
    expect(batch.objects[1].error.code).toBe(413);
  });

  it("enforces quota and rejects an unverified basic object", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const oid = createHash("sha256").update("hello").digest("hex");
    const batch = await handleLfsBatch(lfsRequest("upload", [{ oid, size: 5 }]), bucket, storage, env, repoId, "write", "Bearer git-token");
    expect(batch.status).toBe(200);
    const before = await handleLfsBatch(lfsRequest("download", [{ oid, size: 5 }]), bucket, storage, env, repoId, "read", "Bearer git-token");
    expect((await before.json()).objects[0].error.code).toBe(404);
    bucket.objects.set(`git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`, new TextEncoder().encode("hello"));
    const verify = await handleLfsVerify(new Request(`https://beutl.beditor.net/verify`, {
      method: "POST", body: JSON.stringify({ oid, size: 5 }),
    }), bucket, storage, repoId, oid);
    expect(verify.status).toBe(200);
    const after = await handleLfsBatch(lfsRequest("download", [{ oid, size: 5 }]), bucket, storage, env, repoId, "read", "Bearer git-token");
    expect((await after.json()).objects[0].actions.download.href).toContain("X-Amz-Signature");
  });

  it("keeps wrong multipart content private and releases the reservation", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const oid = "a".repeat(64);
    await storage.put<LfsRecord>(`lfs:${oid}`, { kind: "multipart", size: 4, verified: false, expiresAt: Date.now() + 60_000 });
    const base = `https://beutl.beditor.net/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/multipart`;
    expect((await handleMultipart(new Request(base, { method: "POST" }), bucket, storage, repoId, oid, "")).status).toBe(200);
    const part = new Request(`${base}/parts/1`, {
      method: "PUT", headers: { "x-beutl-git-part-length": "4" }, body: "evil",
    });
    expect((await handleMultipart(part, bucket, storage, repoId, oid, "parts/1")).status).toBe(200);
    expect((await handleMultipart(new Request(`${base}/complete`, { method: "POST" }), bucket, storage, repoId, oid, "complete")).status).toBe(422);
    expect(await storage.get(`lfs:${oid}`)).toBeUndefined();
    expect(await bucket.head(`git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`)).toBeNull();
  });

  it("does not record a truncated multipart part", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const oid = "b".repeat(64);
    await storage.put<LfsRecord>(`lfs:${oid}`, {
      kind: "multipart", size: 4, verified: false, expiresAt: Date.now() + 60_000,
    });
    const base = `https://beutl.beditor.net/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/multipart`;
    await handleMultipart(new Request(base, { method: "POST" }), bucket, storage, repoId, oid, "");
    await expect(handleMultipart(new Request(`${base}/parts/1`, {
      method: "PUT", headers: { "x-beutl-git-part-length": "4" }, body: "abc",
    }), bucket, storage, repoId, oid, "parts/1")).rejects.toThrow();
    expect((await storage.list({ prefix: `part:${oid}:` })).size).toBe(0);
  });

  it("publishes a multipart object only after full SHA-256 verification", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const data = new TextEncoder().encode("good");
    const oid = createHash("sha256").update(data).digest("hex");
    await storage.put<LfsRecord>(`lfs:${oid}`, { kind: "multipart", size: 4, verified: false, expiresAt: Date.now() + 60_000 });
    const base = `https://beutl.beditor.net/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/multipart`;
    await handleMultipart(new Request(base, { method: "POST" }), bucket, storage, repoId, oid, "");
    await handleMultipart(new Request(`${base}/parts/1`, {
      method: "PUT", headers: { "x-beutl-git-part-length": "4" }, body: data,
    }), bucket, storage, repoId, oid, "parts/1");
    const completed = await handleMultipart(new Request(`${base}/complete`, { method: "POST" }), bucket, storage, repoId, oid, "complete");
    expect(completed.status).toBe(200);
    expect((await storage.get<LfsRecord>(`lfs:${oid}`))?.verified).toBe(true);
  });

  it("recovers when R2 completion succeeded before the metadata write", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const data = new TextEncoder().encode("restored");
    const oid = createHash("sha256").update(data).digest("hex");
    bucket.objects.set(`git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`, data);
    await storage.put<LfsRecord>(`lfs:${oid}`, {
      kind: "multipart", size: data.length, verified: false,
      expiresAt: Date.now() + 60_000, uploadId: "already-completed",
    });
    const result = await handleMultipart(new Request(`https://beutl.beditor.net/complete`, {
      method: "POST",
    }), bucket, storage, repoId, oid, "complete");
    expect(result.status).toBe(200);
    expect((await storage.get<LfsRecord>(`lfs:${oid}`))?.verified).toBe(true);
  });
});

describe("Durable Object queue", () => {
  it("aborts outstanding multipart uploads during repository deletion", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const oid = "f".repeat(64);
    const key = `git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`;
    const upload = await bucket.createMultipartUpload(key);
    await storage.put<LfsRecord>(`lfs:${oid}`, {
      kind: "multipart", size: 5 * 1024 ** 3 + 1, verified: false,
      expiresAt: Date.now() + 60_000, uploadId: upload.uploadId,
    });
    const durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    const result = await durable.fetch(new Request("https://git.internal/internal/git/cleanup", {
      method: "DELETE",
      headers: { "x-beutl-repo-id": repoId, "x-beutl-git-scope": "admin" },
    }));
    expect(result.status).toBe(204);
    expect(bucket.uploads.size).toBe(0);
    expect(await storage.get(`lfs:${oid}`)).toBeUndefined();
  });

  it("rejects a second repository ID on the same object", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    const make = (id: string) => new Request(`https://beutl.beditor.net/api/v3/git/${id}.git/info/refs?service=git-upload-pack`, {
      headers: { "x-beutl-repo-id": id, "x-beutl-git-scope": "read" },
    });
    expect((await durable.fetch(make(repoId))).status).toBe(200);
    expect((await durable.fetch(make(otherId))).status).toBe(403);
  });
  it("serializes two requests even when R2 I/O awaits", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    let repoIdGets = 0;
    const originalGet = storage.get.bind(storage);
    storage.get = async <T>(key: string) => {
      if (key === "repoId") repoIdGets++;
      return originalGet<T>(key);
    };
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstRead = true;
    bucket.onGet = async () => {
      if (firstRead) { firstRead = false; entered(); await gate; }
    };
    const durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    const make = () => new Request(`https://beutl.beditor.net/api/v3/git/${repoId}.git/info/refs?service=git-upload-pack`, {
      headers: { "x-beutl-repo-id": repoId, "x-beutl-git-scope": "read" },
    });
    const firstRequest = durable.fetch(make());
    await started;
    const secondRequest = durable.fetch(make());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(repoIdGets).toBe(1);
    release();
    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(repoIdGets).toBe(2);
  });
});
