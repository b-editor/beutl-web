import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { sign } from "hono/jwt";
import { handleLfsBatch, handleLfsVerify, type GitDurableStorage, type LfsRecord } from "../packages/api/src/git/lfs";
import { pruneExpiredLfs, LFS_BASIC_CLEANUP_GRACE_MS, MAX_LFS_SINGLE_PUT_BYTES, MAX_LFS_RECORDS_PER_REPOSITORY } from "../packages/api/src/git/lfs";
import { incomingGitObjectBytes, handleGitHttp, MAX_GIT_REPOSITORY_OBJECTS, MAX_GIT_REPOSITORY_REFS } from "../packages/api/src/git/git-http";
import { createGitRepositoryForOwner, reserveGitLfs, commitGitLfs, GitLfsQuotaExceededError } from "@beutl/db";
import { STORAGE_FREE_QUOTA_BYTES } from "@beutl/core";
import type { GitStorageAccounting } from "../packages/api/src/git/accounting";
import { handleMultipart } from "../packages/api/src/git/multipart";
import { GitRepositoryDurableObject } from "../packages/api/src/git/repo-durable-object";
import { GitObjectStore, type GitObjectBucket, type GitMultipartUpload } from "../packages/api/src/git/git-object-store";
import { issueGitToken, issueMultipartToken, verifyGitToken, verifyMultipartToken } from "../packages/api/src/git/tokens";
import { apiRequestBodyLimit, MAX_API_JSON_REQUEST_BYTES } from "../packages/core/src/request-body-limit";
import { setDbProvider } from "../packages/db/src/provider";
import {
  GIT_DELETE_SWEEP_GRACE_MS,
  reconcileGitRepositoryDeletions,
  reconcileGitAccountStorage,
  reconcileGitLfsReservations,
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

function lfsRequest(operation: "upload" | "download", objects: { oid: string; size: number }[], transfers = ["basic"], ownerId?: string) {
  return new Request(`https://beutl.beditor.net/api/v3/git/${repoId}.git/info/lfs/objects/batch`, {
    method: "POST",
    body: JSON.stringify({ operation, objects, transfers }),
    headers: ownerId ? { "x-beutl-git-owner-id": ownerId } : undefined,
  });
}

class MemoryAccounting implements GitStorageAccounting {
  readonly entries = new Map<string, { size: number; verified: boolean }>();
  constructor(readonly limit: number) {}
  async reserveLfs({ repoId, oid, size }: { repoId: string; oid: string; ownerId: string; size: number; expiresAt: number }) {
    const key = `${repoId}:${oid}`;
    if (this.entries.has(key)) return "existing" as const;
    if ([...this.entries.values()].reduce((total, entry) => total + entry.size, 0) + size > this.limit) {
      return "overQuota" as const;
    }
    this.entries.set(key, { size, verified: false });
    return "reserved" as const;
  }
  async commitLfs(repoId: string, oid: string) { this.entries.get(`${repoId}:${oid}`)!.verified = true; }
  async releaseLfs(repoId: string, oid: string) { this.entries.delete(`${repoId}:${oid}`); }
  async reserveHistory() { return true; }
  async settleHistory() { }
  async releaseRepository(repoId: string) {
    for (const key of this.entries.keys()) if (key.startsWith(`${repoId}:`)) this.entries.delete(key);
  }
  async adoptLfs() { }
  async markAccounted() { }
}

describe("hosted Git maintenance and admission", () => {
  it("recovers an accepted creation using its persisted ID at capacity without creating duplicates or crossing accounts", async () => {
    const rows = new Map<string, any>();
    let count = 19;
    let creations = 0;
    let locks = 0;
    const tx = {
      user: { update: async () => { locks++; } },
      gitRepository: {
        findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
        count: async () => count,
        create: async ({ data }: { data: { id?: string; ownerId: string; name: string } }) => {
          const row = { ...data, id: data.id ?? crypto.randomUUID(), deletedAt: null, createdAt: new Date(), updatedAt: new Date() };
          rows.set(row.id, row); count++; creations++;
          return row;
        },
      },
    };
    const db = { $transaction: async (work: (value: unknown) => Promise<unknown>) => work(tx) };
    setDbProvider(async () => db as never);
    vi.stubEnv("JWT_SECRET", secret);
    vi.stubEnv("JWT_ISSUER", "");
    vi.stubEnv("JWT_AUDIENCE", "");
    try {
      const token = async (owner: string) => sign({
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": owner,
        exp: Math.floor(Date.now() / 1000) + 300,
      }, secret);
      const routeEnv = { ...env, BEUTL_GIT_ENABLED: "true", BEUTL_GIT_REPOSITORIES: {
        idFromName: (id: string) => id, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
      } };
      const create = async (owner: string, body: Record<string, unknown>) => routeGitRequest(
        new Request("https://beutl.example/api/v3/repos", {
          method: "POST", headers: { Authorization: `Bearer ${await token(owner)}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }), routeEnv);
      const intent = { name: "project", creationId: repoId, ownerId: "owner-a" };
      // Simulate losing the first response, then reissuing the same persisted intent.
      expect((await create("owner-a", intent))?.status).toBe(201);
      const recovered = await create("owner-a", intent);
      expect(recovered?.status).toBe(201);
      expect(await recovered!.json()).toMatchObject({ id: repoId, name: "project", url: expect.stringContaining(repoId) });
      expect(count).toBe(20);
      expect(creations).toBe(1);
      expect((await create("owner-a", { ...intent, name: "changed" }))?.status).toBe(409);
      expect((await create("owner-b", { ...intent, ownerId: "owner-b" }))?.status).toBe(409);
      const previousLocks = locks;
      expect((await create("owner-b", intent))?.status).toBe(409);
      expect(locks).toBe(previousLocks);
      expect((await create("owner-a", { ...intent, creationId: "invalid" }))?.status).toBe(400);
      expect((await create("owner-a", { name: "legacy client" }))?.status).toBe(409);
      rows.get(repoId).deletedAt = new Date();
      expect((await create("owner-a", intent))?.status).toBe(409);
      expect(creations).toBe(1);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([2, 3])("rejects a corrupt zero-object pack version %s before creating refs", async (version) => {
    const bucket = new MemoryBucket();
    const pack = Buffer.alloc(32);
    pack.write("PACK");
    pack.writeUInt32BE(version, 4);
    const command = Buffer.from(`${"0".repeat(40)} ${"1".repeat(40)} refs/heads/corrupt-empty\0report-status\n`);
    const body = Buffer.concat([Buffer.from((command.length + 4).toString(16).padStart(4, "0")), command, Buffer.from("0000"), pack]);
    const response = await handleGitHttp(new Request(`https://beutl.example/api/v3/git/${repoId}.git/git-receive-pack`, {
      method: "POST", body,
    }), bucket, repoId, "write");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("checksum");
    expect([...bucket.objects.keys()].filter((key) => key.includes("/refs/"))).toEqual([]);
  });

  it("reserves pack plus index bytes, including highly compressed object counts", () => {
    const pack = new Uint8Array(64);
    pack.set(new TextEncoder().encode("PACK"));
    const view = new DataView(pack.buffer);
    view.setUint32(4, 2);
    view.setUint32(8, 100);
    expect(incomingGitObjectBytes(pack)).toBe(64 + 1072 + 2800);
    expect(incomingGitObjectBytes(new Uint8Array())).toBe(0);
    expect(() => incomingGitObjectBytes(new Uint8Array([1]))).toThrow("Invalid Git pack");
  });

  it("retries serializable repository admission after a write conflict", async () => {
    const events: string[] = [];
    let attempt = 0;
    let active = 19;
    const db = {
      $transaction: async (work: (tx: unknown) => Promise<unknown>, options: { isolationLevel: string }) => {
        expect(options.isolationLevel).toBe("Serializable");
        attempt++;
        return work({
          user: { update: async () => {
            events.push("lock");
            if (attempt === 1) { active = 20; throw { code: "P2034" }; }
          } },
          gitRepository: {
            count: async () => { events.push("count"); return active; },
            create: async () => { events.push("create"); throw new Error("Cannot exceed the limit"); },
          },
        });
      },
    };
    expect(await createGitRepositoryForOwner("owner", "name", 20, db as never)).toBeNull();
    expect(events).toEqual(["lock", "lock", "count"]);
  });

  it.each([false, true])("rechecks an LFS reservation's current plan before commit (expired=%s)", async (expired) => {
    const size = 20 * 1024 ** 3;
    let reservation: { ownerId: string; size: bigint; verified: boolean } | null = null;
    let locks = 0;
    const isolation: Array<string | undefined> = [];
    const subscription = { status: "active", planId: "storage", tier: "100gb", billingOfferId: "offer",
      stripeSubscriptionId: "subscription", currentPeriodStart: new Date(Date.now() - 3600_000),
      currentPeriodEnd: new Date(Date.now() + 3600_000), cancelAt: null };
    const tx = {
      user: { update: async () => { locks++; } },
      subscription: { findUnique: async () => subscription },
      subscriptionEntitlementHold: { findFirst: async () => null },
      gitRepository: { count: async () => 0, findFirst: async () => ({ id: repoId }),
        aggregate: async () => ({ _sum: { historyBytes: 0n, historyReservedBytes: 0n } }) },
      gitLfsStorage: { findUnique: async () => reservation,
        aggregate: async ({ where }: { where: { verified: boolean } }) => ({ _sum: {
          size: reservation?.verified === where.verified ? reservation.size : 0n } }),
        create: async () => { reservation = { ownerId: "owner", size: BigInt(size), verified: false }; },
        updateMany: async () => { reservation!.verified = true; return { count: 1 }; } },
      file: { aggregate: async () => ({ _sum: { size: BigInt(STORAGE_FREE_QUOTA_BYTES + 1) } }) },
      storageUpload: { aggregate: async () => ({ _sum: { size: 0n } }) },
    };
    setDbProvider(async () => ({ $transaction: async (work: (db: unknown) => Promise<unknown>, options?: { isolationLevel?: string }) => {
      isolation.push(options?.isolationLevel);
      return work(tx);
    } }) as never);
    expect(await reserveGitLfs({ repoId, oid: "a".repeat(64), ownerId: "owner", size,
      expiresAt: Date.now() + 24 * 3600_000 })).toBe("reserved");
    if (expired) subscription.currentPeriodEnd = new Date(Date.now() - 1);
    if (expired) {
      await expect(commitGitLfs(repoId, "a".repeat(64))).rejects.toBeInstanceOf(GitLfsQuotaExceededError);
      expect(reservation!.verified).toBe(false);
    } else {
      await commitGitLfs(repoId, "a".repeat(64));
      expect(reservation!.verified).toBe(true);
      // Recover an already committed receipt after the plan subsequently lapses.
      subscription.currentPeriodEnd = new Date(Date.now() - 1);
      await commitGitLfs(repoId, "a".repeat(64));
    }
    expect(locks).toBe(expired ? 2 : 3);
    expect(isolation.slice(1)).toEqual(expired ? ["Serializable"] : ["Serializable", "Serializable"]);
  });

  it.each([true, false].flatMap(signingConfigured => ["deletion", "account", "lfs"]
    .map(kind => ({ kind, signingConfigured }))))(
    "advances $kind maintenance past persistent failures (signingConfigured=$signingConfigured)",
    async ({ kind, signingConfigured }) => {
    const failed = kind === "lfs" ? 20 : 10;
    const rows = Array.from({ length: failed + 2 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      repoId, oid: index.toString(16).padStart(64, "0"), ownerId: "owner",
      deletedAt: new Date(Date.now() - GIT_DELETE_SWEEP_GRACE_MS - 1), cleanupCompleteAt: null,
      maintenanceAttemptedAt: new Date(0), maintenanceFailures: 0,
      cleanupAttemptedAt: new Date(0), cleanupFailures: 0, completed: false,
    }));
    const attempted = new Set<string>();
    const list = async ({ take }: { take: number }) => rows.filter((row) => !row.completed)
      .sort((a, b) => (kind === "lfs" ? a.cleanupAttemptedAt.getTime() - b.cleanupAttemptedAt.getTime()
        : a.maintenanceAttemptedAt.getTime() - b.maintenanceAttemptedAt.getTime()) || a.id.localeCompare(b.id)).slice(0, take);
    const update = async ({ where, data }: { where: { id?: string; oid?: string }; data: Record<string, unknown> }) => {
      const row = rows.find((item) => where.id ? item.id === where.id : item.oid === where.oid)!;
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && "increment" in value) (row as any)[key] += value.increment;
        else (row as any)[key] = value;
      }
      return row;
    };
    setDbProvider(async () => ({ gitRepository: { findMany: list, update },
      gitLfsStorage: { findMany: list, updateMany: update } }) as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const routeEnv = { ...env, BEUTL_GIT_TOKEN_SECRET: signingConfigured ? secret : undefined,
        BEUTL_GIT_ENABLED: "false", BEUTL_GIT_REPOSITORIES: {
        idFromName: (name: string) => name,
        get: (id: unknown) => ({ fetch: async (request: Request) => {
          const row = kind === "lfs" ? rows.find((item) => request.url.endsWith(item.oid))!
            : rows.find((item) => item.id === id)!;
          attempted.add(row.id);
          if (rows.indexOf(row) < failed) return new Response(null, { status: 503 });
          row.completed = true;
          return new Response(null, { status: 204 });
        } }),
      } };
      const reconcile = kind === "deletion" ? reconcileGitRepositoryDeletions
        : kind === "account" ? reconcileGitAccountStorage : reconcileGitLfsReservations;
      expect(await reconcile({ ...routeEnv, BEUTL_GIT_S3_SECRET_ACCESS_KEY: undefined })).toBe(0);
      expect(attempted.size).toBe(0);
      if (!signingConfigured) {
        const response = await routeGitRequest(new Request("https://beutl.example/api/v3/repos"),
          { ...routeEnv, BEUTL_GIT_ENABLED: "true" });
        expect(response?.status).toBe(503);
      }
      expect(await reconcile(routeEnv)).toBe(0);
      expect(await reconcile(routeEnv)).toBe(2);
      expect(attempted.size).toBe(rows.length);
      expect(rows[0][kind === "lfs" ? "cleanupFailures" : "maintenanceFailures"]).toBeGreaterThan(0);
    } finally { log.mockRestore(); }
  });
});

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
      ...env, BEUTL_GIT_ENABLED: "false",
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
    await bucket.put(key, new Uint8Array([3]));
    await durable.alarm();
    expect(bucket.objects.has(key)).toBe(false);
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
  expect(apiRequestBodyLimit("PATCH", `${base}/info/lfs/objects/${"a".repeat(64)}/tus/12345678-1234-1234-1234-123456789012`,
    "application/offset+octet-stream")).toBe(64 * 1024 * 1024);
  expect(apiRequestBodyLimit("POST", `${base}/info/lfs/objects/${"a".repeat(64)}/multipart/parts/1`, "application/octet-stream"))
    .toBe(MAX_API_JSON_REQUEST_BYTES);
});

describe("Git Smart HTTP with the native Git CLI", () => {
  it("pushes and clones a repository through the Durable Object", async () => {
    class CountedBucket extends MemoryBucket {
      padding = 0;
      refPadding = 0;
      override async list(options: Parameters<MemoryBucket["list"]>[0]) {
        const page = await super.list(options);
        // Model many small stored objects for admission without transferring
        // thousands of unrelated packs through the native Git fixture.
        if (options.prefix === `git/repos/${repoId}/repo.git/objects/` && !options.delimiter && !options.cursor) {
          page.objects.push(...Array.from({ length: this.padding }, (_, i) => ({
            key: `${options.prefix}count-fixture/${i}`, size: 0,
          })));
        }
        if (options.prefix === `git/repos/${repoId}/repo.git/refs/` && !options.delimiter && !options.cursor) {
          page.objects.push(...Array.from({ length: this.refPadding }, (_, i) => ({
            key: `${options.prefix}heads/count-fixture/${i}`, size: 41,
          })));
        }
        return page;
      }
    }
    const bucket = new CountedBucket();
    const storage = new MemoryStorage();
    const reservations: number[] = [];
    const accounting = new MemoryAccounting(8 * 1024);
    accounting.reserveHistory = async (...args: unknown[]) => {
      const bytes = args[2] as number;
      reservations.push(bytes);
      return bytes <= 8 * 1024;
    };
    const durable = new GitRepositoryDurableObject({ storage }, env, bucket, accounting);
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
      expect(reservations.length).toBeGreaterThanOrEqual(3);
      expect(reservations.every((bytes) => bytes > 0 && bytes <= 8 * 1024)).toBe(true);

      await git(root, "fetch", "origin", "main");
      await git(root, "reset", "--hard", "FETCH_HEAD");
      const prefix = `git/repos/${repoId}/repo.git/objects/`;
      const existing = await new GitObjectStore(bucket).list(prefix);
      bucket.padding = MAX_GIT_REPOSITORY_OBJECTS - existing.objects.length - 2;
      writeFileSync(join(root, "at-limit.txt"), "last admitted pack\n");
      await git(root, "add", "at-limit.txt");
      await git(root, ...commitArgs);
      await git(root, "push", "origin", "main");
      expect((await new GitObjectStore(bucket).list(prefix)).objects).toHaveLength(MAX_GIT_REPOSITORY_OBJECTS);
      const admittedRefs = [...bucket.objects].filter(([key]) => key.includes("/refs/"));
      const reservationCount = reservations.length;
      writeFileSync(join(root, "too-many.txt"), "must not be admitted\n");
      await git(root, "add", "too-many.txt");
      await git(root, ...commitArgs);
      await expect(git(root, "push", "origin", "main")).rejects.toThrow("413");
      expect([...bucket.objects].filter(([key]) => key.includes("/refs/"))).toEqual(admittedRefs);
      expect(reservations).toHaveLength(reservationCount);
      await git(root, "clone", url, join(root, "copy-at-limit"));
      expect(readFileSync(join(root, "copy-at-limit", "at-limit.txt"), "utf8").replace(/\r\n/gu, "\n"))
        .toBe("last admitted pack\n");
      expect(() => readFileSync(join(root, "copy-at-limit", "too-many.txt"))).toThrow();
      const admittedOid = (await git(join(root, "copy-at-limit"), "rev-parse", "HEAD")).stdout.trim();
      const refsPrefix = `git/repos/${repoId}/repo.git/refs/`;
      bucket.refPadding = MAX_GIT_REPOSITORY_REFS - (await new GitObjectStore(bucket).list(refsPrefix)).objects.length - 1;
      await git(root, "push", "origin", `${admittedOid}:refs/heads/ref-at-limit`);
      expect((await new GitObjectStore(bucket).list(refsPrefix)).objects).toHaveLength(MAX_GIT_REPOSITORY_REFS);
      const refsAtLimit = [...bucket.objects].filter(([key]) => key.includes("/refs/"));
      expect((await new GitObjectStore(bucket).list(prefix)).objects).toHaveLength(MAX_GIT_REPOSITORY_OBJECTS);
      await expect(git(root, "push", "origin", `${admittedOid}:refs/tags/one-too-many`)).rejects.toThrow("413");
      expect([...bucket.objects].filter(([key]) => key.includes("/refs/"))).toEqual(refsAtLimit);
      await git(root, "push", "origin", ":ref-at-limit");
      await git(root, "push", "origin", `${admittedOid}:refs/tags/last-slot-reused`);
      expect((await new GitObjectStore(bucket).list(refsPrefix)).objects).toHaveLength(MAX_GIT_REPOSITORY_REFS);
      await git(root, "push", "origin", ":main");
      expect((await fetch(`${url}/info/refs?service=git-upload-pack`)).status).toBe(200);
    } finally {
      server.close();
      if (!root.startsWith(tmpdir() + sep)) throw new Error("Test directory escaped the temporary root");
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("Git object adapter", () => {
  it("lists all pages without dropping objects", async () => {
    const bucket = new MemoryBucket();
    for (let index = 0; index < 1_001; index++) bucket.objects.set(`key/${index.toString().padStart(4, "0")}`, new Uint8Array([index % 256]));
    expect((await new GitObjectStore(bucket).list("key/")).objects).toHaveLength(1_001);
  });
});

describe("Git LFS reservation and integrity", () => {
  it("prefers tus for a large LFS upload when the client advertises it", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const oid = "e".repeat(64);
    const smallOid = "d".repeat(64);
    const result = await handleLfsBatch(
      lfsRequest("upload", [{ oid, size: 5 * 1024 ** 3 + 1 }, { oid: smallOid, size: 1 }],
        ["basic", "beutl-tus", "beutl-multipart"]),
      bucket, storage, env, repoId, "write", "Bearer git-token",
    );
    const batch = await result.json();
    expect(batch.transfer).toBe("beutl-tus");
    expect(batch.objects[0].actions.upload.href).toContain(`/${oid}/tus`);
    expect(batch.objects[1].actions.upload.href).toContain(`/${smallOid}/tus`);
  });
  it("uses one legacy custom transfer for a mixed batch and accepts an empty object", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const emptyOid = createHash("sha256").digest("hex");
    const batch = await (await handleLfsBatch(
      lfsRequest("upload", [{ oid: "e".repeat(64), size: 5 * 1024 ** 3 + 1 },
        { oid: emptyOid, size: 0 }], ["basic", "beutl-multipart"]),
      bucket, storage, env, repoId, "write", "Bearer git-token",
    )).json();
    expect(batch.transfer).toBe("beutl-multipart");
    expect(batch.objects[1].actions.upload.href).toContain(`/${emptyOid}/multipart`);
    const result = await handleMultipart(new Request(batch.objects[1].actions.upload.href, {
      method: "POST",
    }), bucket, storage, repoId, emptyOid, "");
    expect((await result.json()).complete).toBe(true);
    expect((await storage.get<LfsRecord>(`lfs:${emptyOid}`))?.verified).toBe(true);
    expect(bucket.uploads.size).toBe(0);
  });
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

  it("selects custom transfer immediately above the decimal single-PUT limit", async () => {
    for (const size of [MAX_LFS_SINGLE_PUT_BYTES, MAX_LFS_SINGLE_PUT_BYTES + 1]) {
      const response = await handleLfsBatch(lfsRequest("upload", [{ oid: "e".repeat(64), size }], ["basic", "beutl-tus"]),
        new MemoryBucket(), new MemoryStorage(), env, repoId, "write", "Bearer token");
      const result = await response.json();
      expect(result.transfer).toBe(size === MAX_LFS_SINGLE_PUT_BYTES ? "basic" : "beutl-tus");
    }
  });

  it("bounds renewed multipart actions and tokens by the original reservation expiry", async () => {
    const storage = new MemoryStorage();
    const oid = "9".repeat(64);
    const size = MAX_LFS_SINGLE_PUT_BYTES + 1;
    const expiresAt = Date.now() + 5 * 60_000;
    await storage.put<LfsRecord>(`lfs:${oid}`, { kind: "multipart", size, verified: false, expiresAt });
    const response = await handleLfsBatch(lfsRequest("upload", [{ oid, size }], ["beutl-multipart"]),
      new MemoryBucket(), storage, env, repoId, "write", "Bearer token");
    const { actions } = (await response.json()).objects[0];
    expect(actions.upload.expires_in).toBeGreaterThan(0);
    expect(actions.upload.expires_in).toBeLessThanOrEqual(300);
    expect(actions.verify.expires_in).toBe(actions.upload.expires_in);
    const authorization = actions.upload.header.Authorization;
    const payload = JSON.parse(Buffer.from(authorization.split(".")[1], "base64url").toString());
    expect(payload.exp).toBe(Math.floor(expiresAt / 1000));
    expect(await verifyMultipartToken(secret, authorization, repoId, oid, payload.exp)).toBeNull();
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

  it("bounds zero-byte LFS reservations across batches, including verified records, and reuses freed slots", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const accounting = new MemoryAccounting(10);
    const expiresAt = Date.now() + 60_000;
    for (let i = 0; i < MAX_LFS_RECORDS_PER_REPOSITORY - 1; i++) {
      storage.values.set(`lfs:${i.toString(16).padStart(64, "0")}`, {
        kind: "basic", size: 0, verified: i === 0, expiresAt,
      } satisfies LfsRecord);
    }
    const admitted = "e".repeat(64);
    const rejected = "f".repeat(64);
    const batch = async (oids: string[]) => (await handleLfsBatch(
      lfsRequest("upload", oids.map((oid) => ({ oid, size: 0 })), ["basic"], "owner"),
      bucket, storage, env, repoId, "write", "Bearer token", accounting)).json();
    const first = await batch([admitted, rejected]);
    expect(first.objects[0].actions.upload).toBeDefined();
    expect(first.objects[1].error).toMatchObject({ code: 413, message: expect.stringContaining("count limit") });
    expect(storage.values.size).toBe(MAX_LFS_RECORDS_PER_REPOSITORY);
    expect(accounting.entries.size).toBe(1);
    const retry = await batch([admitted, rejected]);
    expect(retry.objects[0].actions.upload).toBeDefined();
    expect(retry.objects[1].error.code).toBe(413);
    await storage.put<LfsRecord>("lfs:" + "1".padStart(64, "0"), {
      kind: "basic", size: 0, verified: false, expiresAt: Date.now() - LFS_BASIC_CLEANUP_GRACE_MS - 1000,
    });
    expect((await batch([rejected])).objects[0].actions.upload).toBeDefined();
    expect(storage.values.size).toBe(MAX_LFS_RECORDS_PER_REPOSITORY);
    expect(await storage.get("lfs:" + "0".repeat(64))).toMatchObject({ verified: true });
  });

  it("reserves the shared account limit across repositories and releases expired uploads", async () => {
    const accounting = new MemoryAccounting(10);
    const bucket = new MemoryBucket();
    const firstStorage = new MemoryStorage();
    const secondStorage = new MemoryStorage();
    const firstOid = "1".repeat(64);
    const secondOid = "2".repeat(64);
    const [first, second] = await Promise.all([
      handleLfsBatch(lfsRequest("upload", [{ oid: firstOid, size: 6 }], ["basic"], "owner"),
        bucket, firstStorage, env, repoId, "write", "Bearer token", accounting),
      handleLfsBatch(lfsRequest("upload", [{ oid: secondOid, size: 6 }], ["basic"], "owner"),
        bucket, secondStorage, env, otherId, "write", "Bearer token", accounting),
    ]);
    expect((await first.json()).objects[0].actions.upload).toBeDefined();
    expect((await second.json()).objects[0].error).toMatchObject({ code: 413 });
    expect(accounting.entries.size).toBe(1);
    await pruneExpiredLfs(firstStorage, bucket, repoId, Date.now() + 4 * 60 * 60 * 1000, accounting);
    expect(accounting.entries.size).toBe(0);
    const retried = await handleLfsBatch(lfsRequest("upload", [{ oid: secondOid, size: 6 }], ["basic"], "owner"),
      bucket, secondStorage, env, otherId, "write", "Bearer token", accounting);
    expect((await retried.json()).objects[0].actions.upload).toBeDefined();
  });

  it("retains the account reservation when B2 abort fails, then retries safely", async () => {
    class FailingAbortBucket extends MemoryBucket {
      attempts = 0;
      override resumeMultipartUpload(key: string, uploadId: string): GitMultipartUpload {
        const base = super.resumeMultipartUpload(key, uploadId);
        return { ...base, abort: async () => {
          if (++this.attempts === 1) throw new Error("B2 unavailable");
          await base.abort();
        } };
      }
    }
    const bucket = new FailingAbortBucket();
    const storage = new MemoryStorage();
    const accounting = new MemoryAccounting(10);
    const oid = "3".repeat(64);
    const expiresAt = Date.now() - 1;
    await storage.put(`lfs:${oid}`, { kind: "multipart", size: 6, verified: false, expiresAt,
      uploadId: (await bucket.createMultipartUpload("key")).uploadId } satisfies LfsRecord);
    await accounting.reserveLfs({ repoId, oid, ownerId: "owner", size: 6, expiresAt });
    await expect(pruneExpiredLfs(storage, bucket, repoId, Date.now(), accounting)).rejects.toThrow("B2 unavailable");
    expect(accounting.entries.size).toBe(1);
    expect(await storage.get(`lfs:${oid}`)).toBeDefined();
    await pruneExpiredLfs(storage, bucket, repoId, Date.now(), accounting);
    expect(accounting.entries.size).toBe(0);
    expect(await storage.get(`lfs:${oid}`)).toBeUndefined();
  });

  it("prunes only unreferenced LFS versions after the signed upload window", async () => {
    const kept: Array<{ key: string; versions: readonly string[] }> = [];
    class VersionBucket extends MemoryBucket {
      async pruneVersions(key: string, versions: readonly string[]) { kept.push({ key, versions }); }
    }
    const storage = new MemoryStorage();
    const oid = "4".repeat(64);
    await storage.put(`lfs:${oid}`, { kind: "basic", size: 6, verified: true,
      expiresAt: Date.now() - 3 * 60 * 60 * 1000, versionId: "pinned-v1" } satisfies LfsRecord);
    await pruneExpiredLfs(storage, new VersionBucket(), repoId);
    expect(kept).toEqual([{ key: `git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`, versions: ["pinned-v1"] }]);
    expect((await storage.get<LfsRecord>(`lfs:${oid}`))?.gcComplete).toBe(true);
  });

  it.each([false, true])("resumes bounded daily LFS sweeps after a DO restart (failedPage=%s)", async (failedPage) => {
    const storage = new MemoryStorage();
    const completed = new Map<string, number>();
    let failed = false;
    let requests = 0;
    let gitSweeps = 0;
    const failingOid = (16).toString(16).padStart(64, "0");
    class SweptBucket extends MemoryBucket {
      async pruneVersions(key: string, versions: readonly string[]) {
        requests++;
        expect(versions).toEqual(["pinned"]);
        if (failedPage && key.endsWith(failingOid) && !failed) { failed = true; throw new Error("lost sweep response"); }
        completed.set(key, (completed.get(key) ?? 0) + 1);
      }
      async pruneGitVersions() { gitSweeps++; }
    }
    const bucket = new SweptBucket();
    await storage.put("repoId", repoId);
    await storage.put("gitGcPending", true);
    for (let index = 0; index < 120; index++) {
      const oid = index.toString(16).padStart(64, "0");
      await storage.put<LfsRecord>(`lfs:${oid}`, { kind: "basic", size: 1, verified: true,
        versionId: "pinned", gcComplete: true, expiresAt: Date.now() - 3 * 3600_000 });
      await bucket.put(`git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`, new Uint8Array([1]));
    }
    const initial = new GitRepositoryDurableObject({ storage }, env, bucket);
    if (failedPage) await expect(initial.alarm()).rejects.toThrow("lost sweep response");
    else { await initial.alarm(); expect(requests).toBe(50); }
    expect(await storage.get("lfsSweepProgress")).toBeDefined();
    for (let alarm = 0; alarm < 4 && await storage.get("lfsSweepProgress"); alarm++) {
      const before = requests;
      await new GitRepositoryDurableObject({ storage }, env, bucket).alarm();
      expect(requests - before).toBeLessThanOrEqual(50);
    }
    expect(completed.size).toBe(120);
    expect([...completed.values()]).toEqual(Array(120).fill(1));
    expect(gitSweeps).toBe(1);
    expect(await storage.get("lfsSweepProgress")).toBeUndefined();
    const completedAt = (await storage.get<number>("lfsSweepCompletedAt"))!;
    const priorRequests = requests;
    const time = vi.spyOn(Date, "now").mockReturnValue(completedAt + 24 * 3600_000 - 1);
    try {
      // Push/expiry alarms still run other maintenance, without restarting the full pass.
      await storage.put("gitGcPending", true);
      await new GitRepositoryDurableObject({ storage }, env, bucket).alarm();
      expect(requests).toBe(priorRequests);
      expect(gitSweeps).toBe(2);
      expect(storage.alarms.at(-1)).toBe(completedAt + 24 * 3600_000);
      time.mockReturnValue(completedAt + 24 * 3600_000);
      await new GitRepositoryDurableObject({ storage }, env, bucket).alarm();
      expect(requests - priorRequests).toBe(50);
      expect(await storage.get("lfsSweepProgress")).toBeDefined();
      expect(storage.alarms.at(-1)).toBe(completedAt + 24 * 3600_000 + 60_000);
    } finally { time.mockRestore(); }
  });

  it("bounds the first version-pruning pass and keeps adjacent orphan cleanup resumable", async () => {
    const storage = new MemoryStorage();
    let pruned = 0;
    class SweptBucket extends MemoryBucket { async pruneVersions() { pruned++; } }
    const bucket = new SweptBucket();
    await storage.put("repoId", repoId);
    for (let index = 0; index < 120; index++) {
      const oid = index.toString(16).padStart(64, "0");
      await storage.put<LfsRecord>(`lfs:${oid}`, { kind: "basic", size: 1, verified: true,
        versionId: "pinned", expiresAt: Date.now() - 3 * 3600_000 });
      await bucket.put(`git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`, new Uint8Array([1]));
    }
    for (let index = 0; index < 80; index++) {
      const oid = "f" + index.toString(16).padStart(63, "0");
      await bucket.put(`git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`, new Uint8Array([2]));
    }
    for (let alarm = 0; alarm < 10; alarm++) {
      const before = pruned;
      await new GitRepositoryDurableObject({ storage }, env, bucket).alarm();
      expect(pruned - before).toBeLessThanOrEqual(100);
      if (!await storage.get("lfsSweepProgress")) break;
    }
    expect(pruned).toBe(120);
    expect(bucket.objects.size).toBe(120);
    expect(await storage.get("lfsSweepProgress")).toBeUndefined();
  });

  it.each(["basic", "multipart", "tus"])("keeps %s objects private when completion exceeds current account quota", async (kind) => {
    const bytes = new TextEncoder().encode("private until account completion");
    const oid = createHash("sha256").update(bytes).digest("hex");
    const storage = new MemoryStorage();
    const bucket = new MemoryBucket();
    const accounting = new MemoryAccounting(100);
    const resourceId = "00000000-0000-4000-8000-000000000004";
    await accounting.reserveLfs({ repoId, oid, ownerId: "owner", size: bytes.length, expiresAt: Date.now() + 60_000 });
    accounting.commitLfs = async () => { throw new GitLfsQuotaExceededError(); };
    await storage.put<LfsRecord>(`lfs:${oid}`, { kind: kind === "basic" ? "basic" : "multipart",
      size: bytes.length, verified: false, expiresAt: Date.now() + 60_000,
      completed: kind !== "basic", versionId: "test-v1", uploadId: "completed-upload",
      ...(kind === "tus" ? { tusId: resourceId } : {}) });
    await bucket.put(`git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`, bytes);
    const base = `https://beutl.example/api/v3/git/${repoId}.git/info/lfs/objects/${oid}`;
    const result = await new GitRepositoryDurableObject({ storage }, env, bucket, accounting).fetch(new Request(
      kind === "basic" ? `${base}/verify` : kind === "multipart" ? `${base}/multipart/complete` : `${base}/tus/${resourceId}`, {
        method: kind === "tus" ? "HEAD" : "POST",
        headers: { "x-beutl-repo-id": repoId, "x-beutl-git-scope": "write", "Tus-Resumable": "1.0.0" },
        ...(kind === "basic" ? { body: JSON.stringify({ oid, size: bytes.length }) } : {}),
      }));
    expect(result.status).toBe(413);
    expect((await storage.get<LfsRecord>(`lfs:${oid}`))?.verified).toBe(false);
    expect(accounting.entries.get(`${repoId}:${oid}`)?.verified).toBe(false);
    const download = await handleLfsBatch(lfsRequest("download", [{ oid, size: bytes.length }]),
      bucket, storage, env, repoId, "read", "Bearer token", accounting);
    expect((await download.json()).objects[0].error.code).toBe(404);
  });

  it("enforces quota and uses a native streaming hash for an unverified basic object", async () => {
    class NativeOnlyBucket extends MemoryBucket {
      async getRange() { throw new Error("Basic verify must not use JavaScript range checkpoints"); }
    }
    const bucket = new NativeOnlyBucket();
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

describe("tus 1.0 upload backed by B2 multipart", () => {
  const base = (oid: string) =>
    `https://beutl.beditor.net/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/tus`;
  const make = (url: string, method: string, headers: Record<string, string> = {}, body?: Uint8Array) =>
    new Request(url, {
      method,
      headers: {
        "x-beutl-repo-id": repoId, "x-beutl-git-scope": "write",
        ...(method === "OPTIONS" ? {} : { "Tus-Resumable": "1.0.0" }),
        ...headers,
        ...(body ? { "x-beutl-tus-length": String(body.byteLength) } : {}),
      },
      ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}),
    });
  const patch = (url: string, offset: number, bytes: Uint8Array) =>
    make(url, "PATCH", {
      "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream",
    }, bytes);
  const create = async (durable: GitRepositoryDurableObject, oid: string, size: number) => {
    const result = await durable.fetch(make(base(oid), "POST", { "Upload-Length": String(size) }));
    expect(result.status).toBe(201);
    return result.headers.get("Location")!;
  };

  it("creates, queries, patches, verifies and terminates a tus resource", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const first = new Uint8Array(5 * 1024 * 1024);
    first.fill(7);
    const data = new Uint8Array(first.length + 1);
    data.set(first); data[first.length] = 9;
    const oid = createHash("sha256").update(data).digest("hex");
    await storage.put<LfsRecord>(`lfs:${oid}`, {
      kind: "multipart", size: data.length, verified: false, expiresAt: Date.now() + 60_000,
    });
    const durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    const options = await durable.fetch(make(base(oid), "OPTIONS"));
    expect(options.headers.get("Tus-Extension")).toBe("creation,expiration,termination");
    expect(options.headers.get("Tus-Version")).toBe("1.0.0");
    const incompatible = await durable.fetch(make(base(oid), "POST", {
      "Tus-Resumable": "0.9.0", "Upload-Length": String(data.length),
    }));
    expect(incompatible.status).toBe(412);
    expect(incompatible.headers.get("Tus-Version")).toBe("1.0.0");
    const url = await create(durable, oid, data.length);
    expect(await create(durable, oid, data.length)).toBe(url);
    const before = await durable.fetch(make(url, "HEAD"));
    expect(before.headers.get("Upload-Offset")).toBe("0");
    expect(before.headers.get("Upload-Length")).toBe(String(data.length));
    expect(before.headers.get("Cache-Control")).toBe("no-store");
    const wrong = await durable.fetch(patch(url, 1, first));
    expect(wrong.status).toBe(409);
    expect(wrong.headers.get("Upload-Offset")).toBe("0");
    expect(wrong.headers.get("Upload-Expires")).not.toBeNull();
    const empty = await durable.fetch(patch(url, 0, new Uint8Array()));
    expect(empty.status).toBe(204);
    expect(empty.headers.get("Upload-Offset")).toBe("0");
    const firstPatch = await durable.fetch(make(url, "POST", {
      "X-HTTP-Method-Override": "PATCH", "Upload-Offset": "0",
      "Content-Type": "application/offset+octet-stream",
    }, first));
    expect(firstPatch.status).toBe(204);
    expect(firstPatch.headers.get("Upload-Offset")).toBe(String(first.length));
    expect((await durable.fetch(make(url, "HEAD"))).headers.get("Upload-Offset"))
      .toBe(String(first.length));
    expect((await durable.fetch(patch(url, first.length, data.subarray(first.length)))).status).toBe(204);
    expect((await durable.fetch(make(url, "HEAD"))).headers.get("Upload-Offset"))
      .toBe(String(data.length));
    expect((await storage.get<LfsRecord>(`lfs:${oid}`))?.verified).toBe(true);
    const download = await handleLfsBatch(lfsRequest("download", [{ oid, size: data.length }]),
      bucket, storage, env, repoId, "read", "Bearer git-token");
    expect((await download.json()).objects[0].actions.download.href).toContain("versionId=test-v1");
    expect((await durable.fetch(make(url, "DELETE"))).status).toBe(204);
    expect((await durable.fetch(make(url, "HEAD"))).status).toBe(404);
    expect((await bucket.head(`git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`))?.size)
      .toBe(data.length);
  });

  it("finishes an empty tus object without creating an invalid zero-part B2 upload", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const oid = createHash("sha256").digest("hex");
    await storage.put<LfsRecord>(`lfs:${oid}`, {
      kind: "multipart", size: 0, verified: false, expiresAt: Date.now() + 60_000,
    });
    const durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    const url = await create(durable, oid, 0);
    const head = await durable.fetch(make(url, "HEAD"));
    expect(head.headers.get("Upload-Offset")).toBe("0");
    expect((await storage.get<LfsRecord>(`lfs:${oid}`))?.verified).toBe(true);
    expect(bucket.uploads.size).toBe(0);
  });

  it("persists arbitrary small PATCH tails and resumes after their response is lost", async () => {
    const data = new Uint8Array(5 * 1024 * 1024 + 1);
    data.fill(17);
    const oid = createHash("sha256").update(data).digest("hex");
    class LostTailAckStorage extends MemoryStorage {
      lose = true;
      override async put<T>(key: string, value: T) {
        await super.put(key, value);
        if (key === `tus-tail:${oid}:meta` && this.lose) {
          this.lose = false;
          throw new Error("tail response lost");
        }
      }
    }
    const bucket = new MemoryBucket();
    const storage = new LostTailAckStorage();
    await storage.put<LfsRecord>(`lfs:${oid}`, {
      kind: "multipart", size: data.length, verified: false, expiresAt: Date.now() + 60_000,
    });
    let durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    const url = await create(durable, oid, data.length);
    await expect(durable.fetch(patch(url, 0, data.subarray(0, 1))))
      .rejects.toThrow("tail response lost");
    durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    expect((await durable.fetch(make(url, "HEAD"))).headers.get("Upload-Offset")).toBe("1");
    expect((await durable.fetch(patch(url, 0, data.subarray(0, 1)))).status).toBe(409);
    const next = 1 + 1024 * 1024;
    expect((await durable.fetch(patch(url, 1, data.subarray(1, next)))).headers.get("Upload-Offset"))
      .toBe(String(next));
    durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    expect((await durable.fetch(make(url, "HEAD"))).headers.get("Upload-Offset")).toBe(String(next));
    const boundary = 5 * 1024 * 1024;
    expect((await durable.fetch(patch(url, next, data.subarray(next, boundary)))).headers.get("Upload-Offset"))
      .toBe(String(boundary));
    const record = await storage.get<LfsRecord>(`lfs:${oid}`);
    expect(bucket.uploads.get(record!.uploadId!)?.get(1)?.byteLength).toBe(boundary);
    expect((await durable.fetch(patch(url, boundary, data.subarray(boundary)))).status).toBe(204);
    expect((await storage.get<LfsRecord>(`lfs:${oid}`))?.verified).toBe(true);
    expect((await storage.list({ prefix: `tus-tail:${oid}:` })).size).toBe(0);
  });

  it("keeps the old offset if a new tail generation fails before its pointer is committed", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const oid = createHash("sha256").update(bytes).digest("hex");
    class InterruptedStorage extends MemoryStorage {
      failChunk = false;
      override async put<T>(key: string, value: T) {
        await super.put(key, value);
        if (this.failChunk && key.startsWith(`tus-tail:${oid}:`) && key.endsWith(":0")) {
          this.failChunk = false;
          throw new Error("tail write interrupted");
        }
      }
    }
    const bucket = new MemoryBucket();
    const storage = new InterruptedStorage();
    await storage.put<LfsRecord>(`lfs:${oid}`, {
      kind: "multipart", size: bytes.length, verified: false, expiresAt: Date.now() + 60_000,
    });
    let durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    const url = await create(durable, oid, bytes.length);
    expect((await durable.fetch(patch(url, 0, bytes.subarray(0, 1)))).status).toBe(204);
    storage.failChunk = true;
    await expect(durable.fetch(patch(url, 1, bytes.subarray(1, 2))))
      .rejects.toThrow("tail write interrupted");
    durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    expect((await durable.fetch(make(url, "HEAD"))).headers.get("Upload-Offset")).toBe("1");
    expect((await durable.fetch(patch(url, 1, bytes.subarray(1, 2)))).headers.get("Upload-Offset"))
      .toBe("2");
    expect((await durable.fetch(patch(url, 2, bytes.subarray(2)))).status).toBe(204);
    expect((await storage.get<LfsRecord>(`lfs:${oid}`))?.verified).toBe(true);
    expect((await storage.list({ prefix: `tus-tail:${oid}:` })).size).toBe(0);
  });

  it("splits a final 64 MiB PATCH after a pending tail into valid B2 parts", async () => {
    const firstSize = 1024 * 1024;
    const data = new Uint8Array(firstSize + 64 * 1024 * 1024);
    data.fill(8);
    const oid = createHash("sha256").update(data).digest("hex");
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    await storage.put<LfsRecord>(`lfs:${oid}`, {
      kind: "multipart", size: data.length, verified: false, expiresAt: Date.now() + 60_000,
    });
    const durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    const url = await create(durable, oid, data.length);
    expect((await durable.fetch(patch(url, 0, data.subarray(0, firstSize)))).status).toBe(204);
    expect((await durable.fetch(patch(url, firstSize, data.subarray(firstSize)))).status).toBe(204);
    expect((await durable.fetch(make(url, "HEAD"))).headers.get("Upload-Offset"))
      .toBe(String(data.length));
    expect((await storage.get<LfsRecord>(`lfs:${oid}`))?.verified).toBe(true);
    expect((await storage.list({ prefix: `tus-tail:${oid}:` })).size).toBe(0);
  }, 20_000);

  it("retries a failed final SHA read on HEAD and removes a mismatched OID", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const bytes = new Uint8Array([1, 2, 3]);
    const oid = createHash("sha256").update(bytes).digest("hex");
    await storage.put<LfsRecord>(`lfs:${oid}`, {
      kind: "multipart", size: bytes.length, verified: false, expiresAt: Date.now() + 60_000,
    });
    let durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    const url = await create(durable, oid, bytes.length);
    bucket.onGet = async () => { bucket.onGet = undefined; throw new Error("B2 GET interrupted"); };
    await expect(durable.fetch(patch(url, 0, bytes))).rejects.toThrow("B2 GET interrupted");
    expect((await storage.get<LfsRecord>(`lfs:${oid}`))?.verified).toBe(false);
    durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    expect((await durable.fetch(make(url, "HEAD"))).headers.get("Upload-Offset"))
      .toBe(String(bytes.length));
    expect((await storage.get<LfsRecord>(`lfs:${oid}`))?.verified).toBe(true);

    const badOid = createHash("sha256").update(new Uint8Array([9, 9, 9])).digest("hex");
    await storage.put<LfsRecord>(`lfs:${badOid}`, {
      kind: "multipart", size: bytes.length, verified: false, expiresAt: Date.now() + 60_000,
    });
    const badUrl = await create(durable, badOid, bytes.length);
    expect((await durable.fetch(patch(badUrl, 0, bytes.subarray(0, 1)))).status).toBe(204);
    expect((await durable.fetch(patch(badUrl, 1, bytes.subarray(1)))).status).toBe(422);
    expect(await storage.get(`lfs:${badOid}`)).toBeUndefined();
    expect((await durable.fetch(make(badUrl, "HEAD"))).status).toBe(404);
    expect((await storage.list({ prefix: `tus-tail:${badOid}:` })).size).toBe(0);
    expect(await bucket.head(`git-lfs/repos/${repoId}/${badOid.slice(0, 2)}/${badOid}`)).toBeNull();
  });

  it("recovers an accepted part after its response is lost and rejects a competing stale offset", async () => {
    class LostPartBucket extends MemoryBucket {
      lose = true;
      override resumeMultipartUpload(key: string, uploadId: string): GitMultipartUpload {
        const upload = super.resumeMultipartUpload(key, uploadId);
        return { ...upload, uploadPart: async (partNumber, body, length) => {
          const accepted = await upload.uploadPart(partNumber, body, length);
          if (this.lose) { this.lose = false; throw new Error("response lost"); }
          return accepted;
        } };
      }
    }
    const bucket = new LostPartBucket();
    const storage = new MemoryStorage();
    const first = new Uint8Array(5 * 1024 * 1024);
    const last = new Uint8Array([1]);
    const oid = createHash("sha256").update(first).update(last).digest("hex");
    await storage.put<LfsRecord>(`lfs:${oid}`, {
      kind: "multipart", size: first.length + 1, verified: false, expiresAt: Date.now() + 60_000,
    });
    const initial = new GitRepositoryDurableObject({ storage }, env, bucket);
    const url = await create(initial, oid, first.length + 1);
    expect((await initial.fetch(patch(url, 0, first.subarray(0, 1)))).status).toBe(204);
    await expect(initial.fetch(patch(url, 1, first.subarray(1)))).rejects.toThrow("response lost");
    const restarted = new GitRepositoryDurableObject({ storage }, env, bucket);
    expect((await restarted.fetch(make(url, "HEAD"))).headers.get("Upload-Offset"))
      .toBe(String(first.length));
    const stale = await restarted.fetch(patch(url, 0, first));
    expect(stale.status).toBe(409);
    const competing = await Promise.all([
      restarted.fetch(patch(url, first.length, last)),
      restarted.fetch(patch(url, first.length, last)),
    ]);
    expect(competing.map((response) => response.status).sort()).toEqual([204, 409]);
    expect((await storage.get<LfsRecord>(`lfs:${oid}`))?.verified).toBe(true);
  });

  it("recovers B2 completion after the completion response is lost", async () => {
    class LostCompletionBucket extends MemoryBucket {
      lose = true;
      override resumeMultipartUpload(key: string, uploadId: string): GitMultipartUpload {
        const upload = super.resumeMultipartUpload(key, uploadId);
        return { ...upload, complete: async (parts) => {
          const completed = await upload.complete(parts);
          if (this.lose) { this.lose = false; throw new Error("completion response lost"); }
          return completed;
        } };
      }
    }
    const bucket = new LostCompletionBucket();
    const storage = new MemoryStorage();
    const bytes = new Uint8Array([1, 2, 3]);
    const oid = createHash("sha256").update(bytes).digest("hex");
    await storage.put<LfsRecord>(`lfs:${oid}`, {
      kind: "multipart", size: bytes.length, verified: false, expiresAt: Date.now() + 60_000,
    });
    const initial = new GitRepositoryDurableObject({ storage }, env, bucket);
    const url = await create(initial, oid, bytes.length);
    await expect(initial.fetch(patch(url, 0, bytes))).rejects.toThrow("completion response lost");
    const restarted = new GitRepositoryDurableObject({ storage }, env, bucket);
    expect((await restarted.fetch(make(url, "HEAD"))).headers.get("Upload-Offset"))
      .toBe(String(bytes.length));
    expect((await storage.get<LfsRecord>(`lfs:${oid}`))?.verified).toBe(true);
  });

  it("serves an authenticated tus upload over local HTTP across a DO restart", async () => {
    const bucket = new MemoryBucket();
    const storage = new MemoryStorage();
    const first = new Uint8Array(5 * 1024 * 1024);
    first.fill(3);
    const final = new Uint8Array([4]);
    const oid = createHash("sha256").update(first).update(final).digest("hex");
    await storage.put<LfsRecord>(`lfs:${oid}`, {
      kind: "multipart", size: first.length + final.length, verified: false,
      expiresAt: Date.now() + 60_000,
    });
    setDbProvider(async () => ({
      gitRepository: {
        findFirst: async ({ where }: { where: { ownerId: string; id: string } }) =>
          where.ownerId === "owner-a" && where.id === repoId ? { id: repoId } : null,
      },
    }) as never);
    let durable = new GitRepositoryDurableObject({ storage }, env, bucket);
    const routeEnv = {
      ...env, BEUTL_GIT_ENABLED: "true",
      BEUTL_GIT_REPOSITORIES: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: (request: Request) => durable.fetch(request) }),
      },
    };
    const server = createServer(async (incoming, outgoing) => {
      try {
        const address = `http://127.0.0.1:${(server.address() as { port: number }).port}${incoming.url}`;
        const headers = new Headers(incoming.headers as Record<string, string>);
        if (incoming.method === "PATCH" && incoming.headers["content-length"])
          headers.set("x-beutl-tus-length", incoming.headers["content-length"]);
        const request = new Request(address, {
          method: incoming.method, headers,
          ...(["POST", "PATCH"].includes(incoming.method ?? "")
            ? { body: Readable.toWeb(incoming), duplex: "half" } : {}),
        } as RequestInit & { duplex?: "half" });
        const response = await routeGitRequest(request, routeEnv);
        if (!response) throw new Error("Git route missing");
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        outgoing.writeHead(500);
        outgoing.end(String(error));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}` +
        `/api/v3/git/${repoId}.git/info/lfs/objects/${oid}/tus`;
      const token = await issueMultipartToken(secret, "owner-a", repoId, oid);
      const headers = { Authorization: `Bearer ${token}`, "Tus-Resumable": "1.0.0" };
      const denied = await fetch(url, { method: "POST", headers: { "Upload-Length": String(first.length + 1) } });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("Tus-Resumable")).toBe("1.0.0");
      const created = await fetch(url, {
        method: "POST", headers: { ...headers, "Upload-Length": String(first.length + 1) },
      });
      expect(created.status).toBe(201);
      const upload = created.headers.get("Location")!;
      expect((await fetch(upload, {
        method: "PATCH", headers: { ...headers, "Upload-Offset": "0",
          "Content-Type": "application/offset+octet-stream" }, body: Buffer.from(first),
      })).headers.get("Upload-Offset")).toBe(String(first.length));
      durable = new GitRepositoryDurableObject({ storage }, env, bucket);
      expect((await fetch(upload, { method: "HEAD", headers })).headers.get("Upload-Offset"))
        .toBe(String(first.length));
      const completed = await fetch(upload, {
        method: "PATCH", headers: { ...headers, "Upload-Offset": String(first.length),
          "Content-Type": "application/offset+octet-stream" }, body: Buffer.from(final),
      });
      expect(completed.status).toBe(204);
      expect(completed.headers.get("Upload-Offset")).toBe(String(first.length + 1));
      expect((await storage.get<LfsRecord>(`lfs:${oid}`))?.verified).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe("Durable Object queue", () => {
  it("initializes one DB client per cold invocation, including alarms", async () => {
    setDbProvider(async () => { throw new Error("Worker.fetch was never initialized"); });
    const storage = new MemoryStorage();
    await storage.put("repoId", repoId);
    for (const digit of ["a", "b"]) await storage.put(`lfs:${digit.repeat(64)}`, {
      kind: "basic", size: 1, verified: false, expiresAt: Date.now() - 4 * 60 * 60 * 1000,
    } satisfies LfsRecord);
    let clients = 0;
    let closed = 0;
    let adopted = 0;
    let released = 0;
    const factory = async () => {
      clients++;
      return {
        gitLfsStorage: {
          findUnique: async () => null,
          upsert: async () => { adopted++; },
          deleteMany: async () => { released++; },
        },
        gitRepository: { update: async () => ({}), updateMany: async () => ({ count: 1 }) },
        $disconnect: async () => { closed++; },
      } as never;
    };
    const durable = new GitRepositoryDurableObject({ storage }, env, new MemoryBucket(), undefined, factory);
    const request = () => new Request("https://git.internal/internal/git/accounting", {
      method: "POST", headers: { "x-beutl-repo-id": repoId, "x-beutl-git-scope": "admin", "x-beutl-git-owner-id": "owner" },
    });
    expect((await durable.fetch(request())).status).toBe(204);
    expect([clients, closed, adopted]).toEqual([1, 1, 2]);
    await durable.alarm();
    expect([clients, closed, released]).toEqual([2, 2, 2]);
    expect((await durable.fetch(request())).status).toBe(204);
    expect([clients, closed]).toEqual([3, 3]);
  });

  it("keeps expired Basic PUTs reserved through a later sweep and finds orphan writes afterwards", async () => {
    const storage = new MemoryStorage();
    const bucket = new MemoryBucket();
    const accounting = new MemoryAccounting(10);
    const oid = "6".repeat(64);
    const key = `git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`;
    const expiresAt = Date.now() - 1;
    await storage.put("repoId", repoId);
    await storage.put(`lfs:${oid}`, { kind: "basic", size: 1, verified: false, expiresAt } satisfies LfsRecord);
    await accounting.reserveLfs({ repoId, oid, ownerId: "owner", size: 1, expiresAt });
    await bucket.put(key, new Uint8Array([1]));
    await pruneExpiredLfs(storage, bucket, repoId, Date.now(), accounting);
    expect(bucket.objects.has(key)).toBe(false);
    expect(accounting.entries.size).toBe(1);
    expect((await handleLfsBatch(lfsRequest("upload", [{ oid, size: 1 }]),
      bucket, storage, env, repoId, "write", "Bearer token", accounting).then((r) => r.json())).objects[0].error.code).toBe(409);
    await bucket.put(key, new Uint8Array([2]));
    await pruneExpiredLfs(storage, bucket, repoId, expiresAt + LFS_BASIC_CLEANUP_GRACE_MS + 1, accounting);
    expect(accounting.entries.size).toBe(0);
    expect(await storage.get(`lfs:${oid}`)).toBeUndefined();
    expect(bucket.objects.has(key)).toBe(false);
    // A PUT accepted before URL expiry could take longer than the grace period.
    await bucket.put(key, new Uint8Array([3]));
    await new GitRepositoryDurableObject({ storage }, env, bucket, accounting).alarm();
    expect(bucket.objects.has(key)).toBe(false);
    expect(storage.alarms.at(-1)).toBeGreaterThan(Date.now());
  });

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
