import { handleGitHttp } from "./git-http";
import { handleLfsBatch, handleLfsVerify, pruneExpiredLfs, cleanupExpiredLfsRecord, LFS_BASIC_CLEANUP_GRACE_MS, type GitDurableStorage, type LfsEnvironment, type LfsRecord } from "./lfs";
import type { GitObjectBucket } from "./git-object-store";
import { S3GitObjectBucket, type GitS3Environment } from "./s3-object-store";
import type { GitScope } from "./tokens";
import { abortMultipart, clearTusTail, handleMultipart } from "./multipart";
import { handleTus } from "./tus";
import { databaseGitStorageAccounting, withGitDatabase, type GitStorageAccounting, type GitDatabaseEnvironment } from "./accounting";
import type { PrismaClient } from "@beutl/db";

interface State {
  storage: GitDurableStorage;
}

interface Environment extends LfsEnvironment, GitS3Environment, GitDatabaseEnvironment {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const OID = /^[0-9a-f]{64}$/u;

/** All storage and Git operations for one repository pass through this queue. */
export class GitRepositoryDurableObject {
  private tail: Promise<unknown> = Promise.resolve();
  private bucket?: GitObjectBucket;
  private readonly accounting?: GitStorageAccounting;
  private readonly databaseAccounting: boolean;

  constructor(
    private readonly state: State, private readonly env: Environment,
    testBucket?: GitObjectBucket,
    testAccounting?: GitStorageAccounting,
    private readonly testDatabaseClient?: () => Promise<PrismaClient>,
  ) {
    this.bucket = testBucket;
    this.databaseAccounting = !testAccounting && (!testBucket || !!testDatabaseClient);
    this.accounting = testAccounting ?? (this.databaseAccounting ? databaseGitStorageAccounting : undefined);
  }

  private objectBucket(): GitObjectBucket {
    return this.bucket ??= new S3GitObjectBucket(this.env);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async fetch(request: Request): Promise<Response> {
    return this.enqueue(() => this.withAccounting(() => this.handle(request)));
  }

  private withAccounting<T>(work: () => Promise<T>): Promise<T> {
    return this.databaseAccounting ? withGitDatabase(this.env, work, this.testDatabaseClient) : work();
  }

  async alarm(): Promise<void> {
    await this.enqueue(() => this.withAccounting(async () => {
      const repoId = await this.state.storage.get<string>("repoId");
      if (repoId && UUID.test(repoId)) {
        try {
          if (await this.state.storage.get<boolean>("deleted")) {
            await this.cleanupMultipartUploads(this.objectBucket(), repoId, Infinity);
            await this.deletePrefix(this.objectBucket(), `git/repos/${repoId}/`);
            await this.deletePrefix(this.objectBucket(), `git-lfs/repos/${repoId}/`);
            await this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
            return;
          }
          await pruneExpiredLfs(this.state.storage, this.objectBucket(), repoId, Date.now(), this.accounting);
          await this.sweepLfsObjects(this.objectBucket(), repoId);
          await this.cleanupMultipartUploads(this.objectBucket(), repoId, Date.now() - 26 * 60 * 60 * 1000);
          if (await this.state.storage.get<boolean>("gitGcPending")) {
            await this.objectBucket().pruneGitVersions?.(`git/repos/${repoId}/`);
            await this.state.storage.delete("gitGcPending");
          }
          const now = Date.now();
          const records = await this.state.storage.list<LfsRecord>({ prefix: "lfs:" });
          const next = [...records.values()].map((record) => record.verified
            ? !record.gcComplete ? record.expiresAt + LFS_BASIC_CLEANUP_GRACE_MS : Infinity
            : record.kind === "basic" && record.expiresAt <= now
              ? record.expiresAt + LFS_BASIC_CLEANUP_GRACE_MS : record.expiresAt)
            .filter((time) => time > now);
          await this.state.storage.setAlarm(Math.min(now + 24 * 60 * 60 * 1000, ...next.map((time) => time + 1000)));
        } catch (error) {
          await this.state.storage.setAlarm(Date.now() + 60_000);
          throw error;
        }
      }
    }));
  }

  private async handle(request: Request): Promise<Response> {
    const repoId = request.headers.get("x-beutl-repo-id") ?? "";
    const scope = request.headers.get("x-beutl-git-scope");
    if (!UUID.test(repoId)) return new Response("Repository unavailable", { status: 503 });
    const bucket = this.objectBucket();
    const boundId = await this.state.storage.get<string>("repoId");
    if (boundId && boundId !== repoId) return new Response("Repository mismatch", { status: 403 });
    if (!boundId) await this.state.storage.put("repoId", repoId);

    const path = new URL(request.url).pathname;
    const orphan = /^\/internal\/git\/lfs-cleanup\/([0-9a-f]{64})$/u.exec(path);
    if (request.method === "POST" && orphan) {
      if (scope !== "admin") return new Response("Forbidden", { status: 403 });
      const oid = orphan[1];
      const record = await this.state.storage.get<LfsRecord>(`lfs:${oid}`);
      if (record?.verified) await this.accounting?.commitLfs(repoId, oid);
      else if (record && record.expiresAt <= Date.now()) {
        await cleanupExpiredLfsRecord(this.state.storage, bucket, repoId, oid, record, Date.now(), this.accounting);
      } else if (!record) {
        await bucket.delete(`git-lfs/repos/${repoId}/${oid.slice(0, 2)}/${oid}`);
        await this.accounting?.releaseLfs(repoId, oid);
      }
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && path === "/internal/git/accounting") {
      if (scope !== "admin" || !this.accounting) return new Response("Forbidden", { status: 403 });
      if (await this.state.storage.get<boolean>("deleted")) return new Response("Repository deleted", { status: 410 });
      const ownerId = request.headers.get("x-beutl-git-owner-id") ?? "";
      const records = await this.state.storage.list<LfsRecord>({ prefix: "lfs:" });
      for (const [key, record] of records) {
        await this.accounting.adoptLfs({ repoId, oid: key.slice(4), ownerId,
          size: record.size, verified: record.verified, expiresAt: record.expiresAt });
      }
      await this.accounting.settleHistory(repoId, await this.gitObjectBytes(bucket, repoId));
      await this.accounting.markAccounted(repoId, ownerId);
      return new Response(null, { status: 204 });
    }
    if (request.method === "DELETE" && path === "/internal/git/cleanup") {
      if (scope !== "admin") return new Response("Forbidden", { status: 403 });
      await this.state.storage.put("deleted", true);
      const records = await this.state.storage.list<LfsRecord>({ prefix: "lfs:" });
      for (const [key, record] of records) {
        if (record.kind === "multipart" && !record.verified) {
          await abortMultipart(bucket, this.state.storage, repoId, key.slice(4), record, this.accounting);
        }
      }
      await this.cleanupMultipartUploads(bucket, repoId, Infinity);
      await this.deletePrefix(bucket, `git/repos/${repoId}/`);
      await this.deletePrefix(bucket, `git-lfs/repos/${repoId}/`);
      await this.accounting?.releaseRepository(repoId);
      for (const [key, record] of records) {
        if (record.verified && record.tusId) await clearTusTail(this.state.storage, key.slice(4));
        await this.state.storage.delete(key);
      }
      await this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
      return new Response(null, { status: 204 });
    }
    if (await this.state.storage.get<boolean>("deleted")) {
      return new Response("Repository deleted", { status: 410 });
    }
    if (scope !== "read" && scope !== "write") return new Response("Forbidden", { status: 403 });
    const base = `/api/v3/git/${repoId}.git/`;
    if (!path.startsWith(base)) return new Response("Not found", { status: 404 });
    const operation = path.slice(base.length);
    try {
      if (request.method === "POST" && operation === "info/lfs/objects/batch") {
        return await handleLfsBatch(
          request, bucket, this.state.storage, this.env, repoId, scope as GitScope,
          request.headers.get("authorization") ?? "",
          this.accounting,
        );
      }
      const verify = /^info\/lfs\/objects\/([0-9a-f]{64})\/verify$/u.exec(operation);
      if (request.method === "POST" && verify && OID.test(verify[1])) {
        if (scope !== "write") return new Response("Forbidden", { status: 403 });
        return await handleLfsVerify(request, bucket, this.state.storage, repoId, verify[1], this.accounting);
      }
      const multipart = /^info\/lfs\/objects\/([0-9a-f]{64})\/multipart(?:\/(.*))?$/u.exec(operation);
      if (multipart) {
        if (scope !== "write") return new Response("Forbidden", { status: 403 });
        const record = await this.state.storage.get<LfsRecord>(`lfs:${multipart[1]}`);
        if (record?.tusId) return new Response("Use the tus upload resource", { status: 409 });
        return await handleMultipart(
          request, bucket, this.state.storage, repoId, multipart[1], multipart[2] ?? "", this.accounting,
        );
      }
      const tus = /^info\/lfs\/objects\/([0-9a-f]{64})\/tus(?:\/([0-9a-f-]+))?$/u.exec(operation);
      if (tus) {
        if (scope !== "write") return new Response("Forbidden", { status: 403 });
        return await handleTus(request, bucket, this.state.storage, repoId, tus[1], tus[2], this.accounting);
      }
      if (request.method === "POST" && operation === "git-receive-pack") {
        // git-fs-s3 v0.3.5 names incoming packs with Date.now(). Even with
        // serialization, two pushes in the same millisecond could overwrite
        // a previous pack. Persist the last completion time across DO restarts.
        const last = await this.state.storage.get<number>("lastPushFinishedAt") ?? 0;
        if (Date.now() <= last) {
          await new Promise((resolve) => setTimeout(resolve, last - Date.now() + 1));
        }
        if (this.accounting) {
          // A prior push may have written B2 but lost its response. Reconcile
          // actual current Git objects before taking another reservation.
          await this.accounting.settleHistory(repoId, await this.gitObjectBytes(bucket, repoId));
        }
        try {
          return await handleGitHttp(request, bucket, repoId, scope as GitScope,
            this.accounting ? (bytes) => this.accounting!.reserveHistory(
              repoId, request.headers.get("x-beutl-git-owner-id") ?? "", bytes) : undefined);
        } finally {
          if (bucket.pruneGitVersions) {
            await this.state.storage.put("gitGcPending", true);
            await this.state.storage.setAlarm(Date.now() + 60_000);
          }
          if (this.accounting) {
            await this.accounting.settleHistory(repoId, await this.gitObjectBytes(bucket, repoId));
          }
          await this.state.storage.put("lastPushFinishedAt", Date.now());
        }
      }
      return await handleGitHttp(request, bucket, repoId, scope as GitScope);
    } catch (error) {
      if (error instanceof RangeError) return new Response(error.message, { status: 413 });
      throw error;
    }
  }

  private async gitObjectBytes(bucket: GitObjectBucket, repoId: string): Promise<number> {
    const prefix = `git/repos/${repoId}/repo.git/objects/`;
    let cursor: string | undefined;
    let bytes = 0;
    do {
      const page = await bucket.list({ prefix, cursor, limit: 1000 });
      bytes += page.objects.reduce((total, object) => total + object.size, 0);
      if (bytes > 16 * 1024 * 1024) throw new RangeError("Git history exceeds its accounting limit");
      cursor = page.truncated ? page.cursor : undefined;
      if (page.truncated && !cursor) throw new Error("Git object listing did not advance");
    } while (cursor);
    return bytes;
  }

  private async cleanupMultipartUploads(bucket: GitObjectBucket, repoId: string, initiatedBefore: number): Promise<void> {
    if (!bucket.cleanupMultipartUploads) return;
    const records = await this.state.storage.list<LfsRecord>({ prefix: "lfs:" });
    const active = [...records.values()].filter((record) => !record.verified && record.uploadId)
      .map((record) => record.uploadId!);
    await bucket.cleanupMultipartUploads(`git-lfs/repos/${repoId}/`, active, initiatedBefore);
  }

  private async sweepLfsObjects(bucket: GitObjectBucket, repoId: string): Promise<void> {
    const records = await this.state.storage.list<LfsRecord>({ prefix: "lfs:" });
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: `git-lfs/repos/${repoId}/`, cursor, limit: 1000 });
      for (const object of page.objects) {
        const oid = object.key.slice(object.key.lastIndexOf("/") + 1);
        if (!OID.test(oid)) continue;
        const record = records.get(`lfs:${oid}`);
        if (!record) await bucket.delete(object.key);
        else if (record.verified && record.versionId && record.expiresAt + 2 * 60 * 60 * 1000 <= Date.now()) {
          await bucket.pruneVersions?.(object.key, [record.versionId]);
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
      if (page.truncated && !cursor) throw new Error("LFS object listing did not advance");
    } while (cursor);
  }

  private async deletePrefix(bucket: GitObjectBucket, prefix: string): Promise<void> {
    if (bucket.deletePrefix) return bucket.deletePrefix(prefix);
    // Restart from the first page after deletion; a cursor into a mutating
    // listing can skip objects. A failed batch leaves the tombstone retryable.
    while (true) {
      const page = await bucket.list({ prefix, limit: 1000 });
      if (page.objects.length === 0) return;
      await bucket.delete(page.objects.map((object) => object.key));
    }
  }
}
