import { handleGitHttp } from "./git-http";
import { S3GitObjectBucket, type GitS3Environment } from "./s3-object-store";
import type { GitObjectBucket } from "./git-object-store";
import { databaseGitStorageAccounting, withGitDatabase, type GitDatabaseEnvironment, type GitStorageAccounting } from "./accounting";
import { cleanupLfs, handleLfsBatch, json, lfsKey, MAX_TUS_PATCH_BYTES, MIN_TUS_PART_BYTES,
  partKey, partPrefix, readJson, scheduleGitMaintenance, UPLOAD_LIFETIME_MS,
  type GitDurableStorage, type LfsPart, type LfsRecord } from "./lfs";
import type { Sha256Checkpoint } from "./checkpoint-sha256";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DELETION_GRACE_MS = 2 * 60 * 60 * 1000;
type Environment = GitS3Environment & GitDatabaseEnvironment & { BEUTL_GIT_TOKEN_SECRET?: string };
type Record = LfsRecord & { digest?: string; gcComplete?: boolean };

/** Serializes Git metadata and media receipts; media bodies stay in the Worker. */
export class GitRepositoryDurableObject {
  private tail: Promise<unknown> = Promise.resolve();
  private bucket?: GitObjectBucket;
  private readonly accounting?: GitStorageAccounting;
  constructor(private readonly state: { storage: GitDurableStorage }, private readonly env: Environment,
    bucket?: GitObjectBucket, accounting?: GitStorageAccounting) {
    this.bucket = bucket;
    this.accounting = accounting ?? (bucket ? undefined : databaseGitStorageAccounting);
  }
  private objectBucket(): GitObjectBucket { return this.bucket ??= new S3GitObjectBucket(this.env); }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = () => this.accounting === databaseGitStorageAccounting ? withGitDatabase(this.env, work) : work();
    const result = this.tail.then(run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  fetch(request: Request): Promise<Response> { return this.enqueue(() => this.handle(request)); }

  private async gitBytes(repoId: string): Promise<number> {
    let bytes = 0; let cursor: string | undefined;
    do {
      const page = await this.objectBucket().list({ prefix: `git/repos/${repoId}/`, cursor, limit: 1000 });
      bytes += page.objects.reduce((n, o) => n + o.size, 0);
      if (!page.truncated) return bytes;
      if (!page.cursor || page.cursor === cursor) throw new Error("Git listing did not advance");
      cursor = page.cursor;
    } while (true);
  }
  private async deleteRepository(repoId: string): Promise<boolean> {
    const storage = this.state.storage;
    let deletedAt = await storage.get<number>("deletedAt");
    if (deletedAt === undefined) { deletedAt = Date.now(); await storage.put("deletedAt", deletedAt); }
    const bucket = this.objectBucket();
    await bucket.cleanupMultipartUploads?.(`git-lfs/repos/${repoId}/`, [], Infinity);
    await bucket.deletePrefix?.(`git/repos/${repoId}/`);
    await bucket.deletePrefix?.(`git-lfs/repos/${repoId}/`);
    // A final abort covers parts that were in flight at the first abort.
    if (Date.now() < deletedAt + DELETION_GRACE_MS) {
      await scheduleGitMaintenance(storage, deletedAt + DELETION_GRACE_MS); return false;
    }
    await this.accounting?.releaseRepository(repoId);
    const keys = await storage.list({ prefix: "lfs:" });
    const parts = await storage.list({ prefix: "part:" });
    if (keys.size || parts.size) await storage.delete([...keys.keys(), ...parts.keys()]);
    await storage.put("cleanupComplete", true);
    return true;
  }

  private async handle(request: Request): Promise<Response> {
    const repoId = request.headers.get("x-beutl-repo-id") ?? "";
    const scope = request.headers.get("x-beutl-git-scope");
    if (!UUID.test(repoId)) return new Response("Repository unavailable", { status: 503 });
    const storage = this.state.storage;
    const bound = await storage.get<string>("repoId");
    if (bound && bound !== repoId) return new Response("Repository mismatch", { status: 403 });
    if (!bound) await storage.put("repoId", repoId);
    const path = new URL(request.url).pathname;
    if (path === "/internal/git/history" && request.method === "POST" && scope === "admin") {
      await this.accounting?.settleHistory(repoId, await this.gitBytes(repoId));
      await storage.put("gitGcPending", true);
      await scheduleGitMaintenance(storage, Date.now() + 60_000);
      return new Response(null, { status: 204 });
    }
    if (path === "/internal/git/cleanup" && request.method === "DELETE" && scope === "admin") {
      if (await storage.get<boolean>("cleanupComplete")) return new Response(null, { status: 204 });
      return new Response(null, { status: await this.deleteRepository(repoId) ? 204 : 202 });
    }
    const orphan = /^\/internal\/git\/lfs-cleanup\/([0-9a-f]{64})$/u.exec(path);
    if (orphan && request.method === "POST" && scope === "admin") {
      const r = await storage.get<Record>(`lfs:${orphan[1]}`);
      if (r?.verified) await this.accounting?.commitLfs(repoId, orphan[1]);
      else if (!r || r.expiresAt <= Date.now()) await cleanupLfs(storage, this.objectBucket(), this.accounting, repoId, orphan[1], r);
      return new Response(null, { status: 204 });
    }
    if (await storage.get<number>("deletedAt") !== undefined) return new Response("Repository deleted", { status: 410 });
    if (scope !== "read" && scope !== "write") return new Response("Forbidden", { status: 403 });
    try {
      const media = /^\/internal\/git\/media\/([0-9a-f]{64})\/(status|create|part|accept|cancel|complete|checkpoint)$/u.exec(path);
      if (media) {
        if (media[2] !== "status" && scope !== "write") return new Response("Forbidden", { status: 403 });
        return await this.media(request, repoId, media[1], media[2]);
      }
      const base = `/api/v3/git/${repoId}.git/`;
      const operation = path.startsWith(base) ? path.slice(base.length) : "";
      if (operation === "info/lfs/objects/batch" && request.method === "POST")
        return await handleLfsBatch(request, this.objectBucket(), storage, this.env, repoId, scope, this.accounting);
      if (["info/refs", "git-receive-pack", "git-upload-pack"].includes(operation) &&
          this.accounting && await this.gitBytes(repoId) === 0) {
        // Bare-repository HEAD/config also consume account storage. Reserve the
        // small initialization before git-fs-s3 creates these metadata objects.
        if (!await this.accounting.reserveHistory(repoId, request.headers.get("x-beutl-git-owner-id")!, 4096))
          return new Response("Account storage quota exceeded", { status: 413 });
        try {
          await handleGitHttp(new Request(`https://git.internal${base}info/refs?service=git-upload-pack`),
            this.objectBucket(), repoId, scope);
        } finally { await this.accounting.settleHistory(repoId, await this.gitBytes(repoId)); }
      }
      if (operation === "git-receive-pack" && request.method === "POST") {
        const last = await storage.get<number>("lastPushFinishedAt") ?? 0;
        // B2 can order same-key versions incorrectly within one second.
        const delay = last + 1000 - Date.now();
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        await this.accounting?.settleHistory(repoId, await this.gitBytes(repoId));
        try {
          return await handleGitHttp(request, this.objectBucket(), repoId, scope,
            this.accounting ? bytes => this.accounting!.reserveHistory(repoId, request.headers.get("x-beutl-git-owner-id")!, bytes) : undefined);
        } finally {
          await storage.put("lastPushFinishedAt", Date.now());
          await storage.put("gitGcPending", true);
          await scheduleGitMaintenance(storage, Date.now() + 60_000);
          await this.accounting?.settleHistory(repoId, await this.gitBytes(repoId));
        }
      }
      return await handleGitHttp(request, this.objectBucket(), repoId, scope);
    } catch (error) {
      if (error instanceof RangeError) return new Response(error.message, { status: 413 });
      throw error;
    }
  }

  private async media(request: Request, repoId: string, oid: string, action: string): Promise<Response> {
    const storage = this.state.storage;
    const key = `lfs:${oid}`;
    const record = await storage.get<Record>(key);
    if (!record) return new Response("LFS reservation not found", { status: 404 });
    if (!record.verified && record.expiresAt <= Date.now()) return new Response("Upload expired", { status: 410 });
    if (action === "status" && request.method === "GET") return json(record);
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const input = await readJson(request);
    if (action === "create") {
      if (input.length !== record.size) return new Response("Upload length mismatch", { status: 409 });
      if (!record.uploadId && !record.versionId) {
        record.uploadId = (await this.objectBucket().createMultipartUpload(lfsKey(repoId, oid))).uploadId;
        await storage.put(key, record);
      }
      return json(record);
    }
    if (input.resourceId !== record.resourceId) return new Response("Upload resource not found", { status: 404 });
    if (action === "part") {
      const { offset, length } = input;
      if (record.verified || record.versionId || !record.uploadId || offset !== record.offset)
        return new Response("Upload offset mismatch", { status: 409 });
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TUS_PATCH_BYTES ||
          offset + length > record.size || (length < MIN_TUS_PART_BYTES && offset + length !== record.size) ||
          (length === 0 && record.size !== 0)) return new Response("Invalid tus part length", { status: 400 });
      if (record.lease && record.lease.until > Date.now())
        return new Response("Upload part in progress", { status: 423, headers: { "Retry-After": "1" } });
      record.lease = { id: crypto.randomUUID(), until: Date.now() + 15 * 60_000, offset, length };
      await storage.put(key, record);
      return json({ uploadId: record.uploadId, partNumber: record.partCount + 1, leaseId: record.lease.id });
    }
    if (action === "cancel" || action === "accept") {
      if (!record.lease || input.leaseId !== record.lease.id) return new Response("Upload receipt changed", { status: 409 });
      if (action === "accept") {
        if (typeof input.etag !== "string" || input.etag.length > 256 || input.partNumber !== record.partCount + 1)
          return new Response("Invalid upload receipt", { status: 400 });
        await storage.put(partKey(oid, input.partNumber), { partNumber: input.partNumber, etag: input.etag });
        record.offset += record.lease.length; record.partCount++;
      }
      delete record.lease; await storage.put(key, record); return json(record);
    }
    if (action === "complete") {
      if (record.versionId) return json(record);
      if (record.offset !== record.size || !record.uploadId || record.partCount === 0)
        return new Response("Upload incomplete", { status: 409 });
      let object = await this.objectBucket().head(lfsKey(repoId, oid));
      if (!object) {
        const parts = [...(await storage.list<LfsPart>({ prefix: partPrefix(oid) })).values()]
          .filter(p => p.partNumber <= record.partCount).sort((a, b) => a.partNumber - b.partNumber);
        object = await this.objectBucket().resumeMultipartUpload(lfsKey(repoId, oid), record.uploadId).complete(parts);
      }
      if (object.size !== record.size || !object.versionId) throw new Error("B2 completion has no pinned version");
      record.versionId = object.versionId; await storage.put(key, record); return json(record);
    }
    if (action === "checkpoint") {
      if (record.verified) return json(record);
      if (!record.versionId || input.versionId !== record.versionId ||
          input.expectedOffset !== (record.checkpoint?.offset ?? 0)) return new Response("Verification receipt changed", { status: 409 });
      const checkpoint = input.checkpoint as Sha256Checkpoint | undefined;
      if (input.digest !== undefined) {
        if (input.digest !== oid) {
          await cleanupLfs(storage, this.objectBucket(), this.accounting, repoId, oid, record);
          return new Response("LFS SHA-256 mismatch", { status: 422 });
        }
        record.digest = input.digest;
      } else {
        if (!checkpoint || checkpoint.oid !== oid || checkpoint.size !== record.size || checkpoint.versionId !== record.versionId ||
            checkpoint.offset <= input.expectedOffset || checkpoint.offset >= record.size || checkpoint.offset % 64 !== 0 ||
            checkpoint.words.length !== 8) return new Response("Invalid SHA-256 checkpoint", { status: 400 });
        record.checkpoint = checkpoint;
      }
      await storage.put(key, record);
      if (record.digest) {
        await this.accounting?.commitLfs(repoId, oid);
        record.verified = true; delete record.checkpoint;
        await storage.put(key, record);
        const parts = await storage.list({ prefix: partPrefix(oid) });
        if (parts.size) await storage.delete([...parts.keys()]);
        await scheduleGitMaintenance(storage, Date.now() + 60_000);
      }
      return json(record);
    }
    return new Response("Not found", { status: 404 });
  }

  alarm(): Promise<void> {
    return this.enqueue(async () => {
      const storage = this.state.storage;
      const repoId = await storage.get<string>("repoId");
      if (!repoId) return;
      if (await storage.get<boolean>("cleanupComplete")) return;
      if (await storage.get<number>("deletedAt") !== undefined) {
        try { await this.deleteRepository(repoId); }
        catch (error) { await storage.setAlarm(Date.now() + 60_000); throw error; }
        return;
      }
      const cursor = await storage.get<string>("maintenanceCursor");
      let fullSweep = await storage.get<boolean>("fullSweep") ?? false;
      if (!cursor && Date.now() >= (await storage.get<number>("nextFullSweep") ?? 0)) {
        fullSweep = true; await storage.put("fullSweep", true);
      }
      const records = await storage.list<Record>({ prefix: "lfs:", startAfter: cursor, limit: 50 });
      let failed = false;
      for (const [key, record] of records) {
        try {
          const oid = key.slice(4);
          if (!record.verified && record.expiresAt <= Date.now())
            await cleanupLfs(storage, this.objectBucket(), this.accounting, repoId, oid, record);
          else if (record.verified && record.versionId && (fullSweep || !record.gcComplete)) {
            await this.objectBucket().pruneVersions?.(lfsKey(repoId, oid), [record.versionId]);
            await storage.put(key, { ...record, gcComplete: true });
          }
        } catch (error) { failed = true; console.error("Git media cleanup failed", { repoId, oid: key.slice(4), error }); }
        await storage.put("maintenanceCursor", key);
      }
      if (records.size < 50) {
        await storage.delete("maintenanceCursor");
        if (fullSweep) {
          await storage.put("fullSweep", false);
          await storage.put("nextFullSweep", Date.now() + UPLOAD_LIFETIME_MS);
        }
      }
      try {
        if (await storage.get<boolean>("gitGcPending")) {
          await this.objectBucket().pruneGitVersions?.(`git/repos/${repoId}/`);
          await storage.delete("gitGcPending");
        }
        const active = await storage.list<Record>({ prefix: "lfs:" });
        await this.objectBucket().cleanupMultipartUploads?.(`git-lfs/repos/${repoId}/`,
          [...active.values()].filter(r => !r.verified && r.expiresAt > Date.now()).flatMap(r => r.uploadId ? [r.uploadId] : []),
          Date.now() - UPLOAD_LIFETIME_MS);
      } catch (error) { failed = true; console.error("Git object cleanup failed", { repoId, error }); }
      await scheduleGitMaintenance(storage, Date.now() + (records.size === 50 || failed ? 60_000 : UPLOAD_LIFETIME_MS));
    });
  }
}
