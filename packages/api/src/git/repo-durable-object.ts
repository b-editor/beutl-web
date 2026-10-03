import { handleGitHttp } from "./git-http";
import { handleLfsBatch, handleLfsVerify, pruneExpiredLfs, cleanupExpiredLfsRecord, scheduleGitMaintenance, LFS_BASIC_CLEANUP_GRACE_MS, LFS_MAINTENANCE_BATCH_SIZE, type GitDurableStorage, type LfsEnvironment, type LfsRecord } from "./lfs";
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
interface LfsSweepProgress { startedAt: number; cursor?: string }
export const GIT_DELETED_REPOSITORY_CLEANUP_MS = 7 * 24 * 60 * 60 * 1000;

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
            const deletedAt = await this.deletionTime();
            await this.cleanupMultipartUploads(this.objectBucket(), repoId, Infinity);
            await this.deletePrefix(this.objectBucket(), `git/repos/${repoId}/`);
            await this.deletePrefix(this.objectBucket(), `git-lfs/repos/${repoId}/`);
            await this.scheduleDeletedCleanup(deletedAt);
            return;
          }
          let progress = await this.state.storage.get<LfsSweepProgress>("lfsSweepProgress");
          const lastSweep = await this.state.storage.get<number>("lfsSweepCompletedAt");
          if (!progress && (lastSweep === undefined || Date.now() - lastSweep >= 24 * 60 * 60 * 1000)) {
            progress = { startedAt: Date.now() };
            await this.state.storage.put("lfsSweepProgress", progress);
          }
          const reservationsPending = await pruneExpiredLfs(this.state.storage, this.objectBucket(), repoId, Date.now(), this.accounting);
          const sweepPending = progress ? await this.sweepLfsObjects(this.objectBucket(), repoId) : false;
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
          await this.state.storage.setAlarm(Math.min(
            now + (reservationsPending || sweepPending ? 60_000 : 24 * 60 * 60 * 1000),
            sweepPending ? Infinity : (await this.state.storage.get<number>("lfsSweepCompletedAt") ?? now) + 24 * 60 * 60 * 1000,
            ...next.map((time) => time + 1000)));
        } catch (error) {
          await this.state.storage.setAlarm(Date.now() + 60_000);
          throw error;
        }
      }
    }));
  }

  private async deletionTime(): Promise<number> {
    const recorded = await this.state.storage.get<number>("deletedAt");
    if (recorded !== undefined) return recorded;
    const now = Date.now();
    // Older tombstones get one persisted window; restarts never extend it.
    await this.state.storage.put("deletedAt", now);
    return now;
  }

  private async scheduleDeletedCleanup(deletedAt: number): Promise<void> {
    const deadline = deletedAt + GIT_DELETED_REPOSITORY_CLEANUP_MS;
    const now = Date.now();
    if (now < deadline) await this.state.storage.setAlarm(Math.min(now + 24 * 60 * 60 * 1000, deadline));
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
      const previousOwner = await this.state.storage.get<string>("accountingOwnerId");
      if (!ownerId || previousOwner && previousOwner !== ownerId) return new Response("Accounting owner mismatch", { status: 409 });
      await this.state.storage.put("accountingOwnerId", ownerId);
      if (!await this.state.storage.get<boolean>("accountingLfsComplete")) {
        const cursor = await this.state.storage.get<string>("accountingLfsCursor");
        const records = await this.state.storage.list<LfsRecord>({ prefix: "lfs:", startAfter: cursor,
          limit: LFS_MAINTENANCE_BATCH_SIZE });
        for (const [key, record] of records) {
          await this.accounting.adoptLfs({ repoId, oid: key.slice(4), ownerId,
            size: record.size, verified: record.verified, expiresAt: record.expiresAt });
          // Persist each accepted upsert so a failed invocation resumes after it.
          await this.state.storage.put("accountingLfsCursor", key);
        }
        if (records.size === LFS_MAINTENANCE_BATCH_SIZE) {
          return new Response(null, { status: 202, headers: { "Retry-After": "60" } });
        }
      }
      await this.accounting.settleHistory(repoId, await this.gitObjectBytes(bucket, repoId));
      await this.accounting.markAccounted(repoId, ownerId);
      await this.state.storage.put("accountingLfsComplete", true);
      await this.state.storage.delete("accountingLfsCursor");
      return new Response(null, { status: 204 });
    }
    if (request.method === "DELETE" && path === "/internal/git/cleanup") {
      if (scope !== "admin") return new Response("Forbidden", { status: 403 });
      const deletedAt = await this.deletionTime();
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
      await this.scheduleDeletedCleanup(deletedAt);
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
            await scheduleGitMaintenance(this.state.storage, Date.now() + 60_000);
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

  private async sweepLfsObjects(bucket: GitObjectBucket, repoId: string): Promise<boolean> {
    const progress = (await this.state.storage.get<LfsSweepProgress>("lfsSweepProgress"))!;
    const page = await bucket.list({ prefix: `git-lfs/repos/${repoId}/`, cursor: progress.cursor,
      limit: LFS_MAINTENANCE_BATCH_SIZE });
    let deleted = false;
    for (const object of page.objects) {
      const oid = object.key.slice(object.key.lastIndexOf("/") + 1);
      if (!OID.test(oid)) continue;
      const key = `lfs:${oid}`;
      const record = await this.state.storage.get<LfsRecord>(key);
      if (!record) { await bucket.delete(object.key); deleted = true; }
      else if (record.verified && record.versionId && bucket.pruneVersions &&
          record.expiresAt + LFS_BASIC_CLEANUP_GRACE_MS <= Date.now() &&
          (record.versionSweepAt ?? 0) < progress.startedAt) {
        await bucket.pruneVersions(object.key, [record.versionId]);
        // Resume a failed page without pruning the already completed keys again.
        await this.state.storage.put(key, { ...record, gcComplete: true, versionSweepAt: progress.startedAt });
      }
    }
    // Deleting objects changes the listing. Re-read this page before advancing
    // its opaque S3 continuation token, so adjacent orphan keys cannot be skipped.
    if (deleted) return true;
    if (page.truncated) {
      if (!page.cursor || page.cursor === progress.cursor) throw new Error("LFS object listing did not advance");
      await this.state.storage.put<LfsSweepProgress>("lfsSweepProgress", { ...progress, cursor: page.cursor });
      return true;
    }
    await this.state.storage.put("lfsSweepCompletedAt", Date.now());
    await this.state.storage.delete("lfsSweepProgress");
    return false;
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
