import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { MAX_GIT_LFS_PART_BYTES } from "@beutl/core";
import { advertiseGitRefs, initializeGitRepository, isGitService, receiveGitPack, uploadGitPack, type GitService } from "./git-http";
import { S3GitObjectBucket, type GitS3Environment } from "./s3-object-store";
import type { GitObjectBucket } from "./git-object-store";
import { databaseGitStorageAccounting, withGitDatabase, type GitDatabaseEnvironment, type GitStorageAccounting } from "./accounting";
import { cleanupLfs, handleLfsBatch, json, lfsKey, MIN_TUS_PART_BYTES,
  partKey, partPrefix, readJson, scheduleGitMaintenance, UPLOAD_LIFETIME_MS,
  type GitDurableStorage, type LfsPart, type LfsRecord } from "./lfs";
import type { Sha256Checkpoint } from "./checkpoint-sha256";
import type { GitScope } from "./tokens";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MEDIA = "/internal/git/media/:oid{[0-9a-f]{64}}";
const DELETION_GRACE_MS = 2 * 60 * 60 * 1000;
type Environment = GitS3Environment & GitDatabaseEnvironment;
type Record = LfsRecord & { digest?: string; gcComplete?: boolean };
type Routes = { Variables: { repoId: string } };
// Only the Worker reaches this object. It verified the token and ownership, and
// it overwrites these headers on every request it forwards.
const scopeOf = (c: Context) => c.req.header("x-beutl-git-scope") ?? "";
const ownerOf = (c: Context) => c.req.header("x-beutl-git-owner-id")!;
type MediaAction = (repoId: string, oid: string, record: Record, input: any) => Promise<Response>;

/** Serializes Git metadata and media receipts; media bodies stay in the Worker. */
export class GitRepositoryDurableObject {
  private tail: Promise<unknown> = Promise.resolve();
  private bucket?: GitObjectBucket;
  private readonly accounting?: GitStorageAccounting;
  private readonly app: Hono<Routes>;
  constructor(private readonly state: { storage: GitDurableStorage }, private readonly env: Environment,
    bucket?: GitObjectBucket, accounting?: GitStorageAccounting) {
    this.bucket = bucket;
    this.accounting = accounting ?? (bucket ? undefined : databaseGitStorageAccounting);
    this.app = this.routes();
  }
  private objectBucket(): GitObjectBucket { return this.bucket ??= new S3GitObjectBucket(this.env); }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = () => this.accounting === databaseGitStorageAccounting ? withGitDatabase(this.env, work) : work();
    const result = this.tail.then(run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  fetch(request: Request): Promise<Response> { return this.enqueue(async () => this.app.fetch(request)); }

  private routes(): Hono<Routes> {
    const storage = this.state.storage;
    const scope = (...allowed: string[]) => createMiddleware<Routes>(async (c, next) => {
      if (!allowed.includes(scopeOf(c))) return c.text("Forbidden", 403);
      await next();
    });
    const active = createMiddleware<Routes>(async (c, next) => {
      if (await storage.get<number>("deletedAt") !== undefined) return c.text("Repository deleted", 410);
      await next();
    });
    // Bare-repository HEAD/config also consume account storage. Reserve the
    // small initialization before git-fs-s3 creates these metadata objects.
    const initialized = createMiddleware<Routes>(async (c, next) => {
      const repoId = c.get("repoId");
      if (this.accounting && await this.gitBytes(repoId) === 0) {
        if (!await this.accounting.reserveHistory(repoId, ownerOf(c), 4096))
          return c.text("Account storage quota exceeded", 413);
        try { await initializeGitRepository(this.objectBucket(), repoId); }
        finally { await this.accounting.settleHistory(repoId, await this.gitBytes(repoId)); }
      }
      await next();
    });
    // Reject a bad ref advertisement before initialization reserves account storage.
    const advertisedService = createMiddleware<Routes>(async (c, next) => {
      const service = c.req.query("service");
      if (!isGitService(service)) return c.text("Unsupported Git service", 400);
      if (service === "git-receive-pack" && scopeOf(c) !== "write") return c.text("Forbidden", 403);
      await next();
    });
    const reservation = async (c: Context<Routes>): Promise<Record | Response> => {
      const record = await storage.get<Record>(`lfs:${c.req.param("oid")}`);
      if (!record) return c.text("LFS reservation not found", 404);
      if (!record.verified && record.expiresAt <= Date.now()) return c.text("Upload expired", 410);
      return record;
    };
    // Every receipt except create names the tus resource it belongs to.
    const media = (action: MediaAction, { resource = true } = {}) => async (c: Context<Routes>) => {
      const record = await reservation(c);
      if (record instanceof Response) return record;
      const input = await readJson(c.req.raw);
      if (resource && input.resourceId !== record.resourceId) return c.text("Upload resource not found", 404);
      return action(c.get("repoId"), c.req.param("oid")!, record, input);
    };

    return new Hono<Routes>()
      // One object serves one repository for its whole lifetime.
      .use(async (c, next) => {
        const repoId = c.req.header("x-beutl-repo-id") ?? "";
        if (!UUID.test(repoId)) return c.text("Repository unavailable", 503);
        const bound = await storage.get<string>("repoId");
        if (bound && bound !== repoId) return c.text("Repository mismatch", 403);
        if (!bound) await storage.put("repoId", repoId);
        c.set("repoId", repoId);
        await next();
      })
      .post("/internal/git/history", scope("admin"), async (c) => {
        const repoId = c.get("repoId");
        await this.accounting?.settleHistory(repoId, await this.gitBytes(repoId));
        await storage.put("gitGcPending", true);
        await scheduleGitMaintenance(storage, Date.now() + 60_000);
        return c.body(null, 204);
      })
      .delete("/internal/git/cleanup", scope("admin"), async (c) => {
        if (await storage.get<boolean>("cleanupComplete")) return c.body(null, 204);
        return c.body(null, await this.deleteRepository(c.get("repoId")) ? 204 : 202);
      })
      .post("/internal/git/lfs-cleanup/:oid{[0-9a-f]{64}}", scope("admin"), async (c) => {
        const repoId = c.get("repoId"), oid = c.req.param("oid");
        const r = await storage.get<Record>(`lfs:${oid}`);
        if (r?.verified) await this.accounting?.commitLfs(repoId, oid);
        else if (!r || r.expiresAt <= Date.now()) await cleanupLfs(storage, this.objectBucket(), this.accounting, repoId, oid, r);
        return c.body(null, 204);
      })
      .use("/internal/git/media/*", active, scope("read", "write"))
      .get(`${MEDIA}/status`, async (c) => {
        const record = await reservation(c);
        return record instanceof Response ? record : json(record);
      })
      .post(`${MEDIA}/create`, scope("write"), media((repoId, oid, record, input) =>
        this.createUpload(repoId, oid, record, input), { resource: false }))
      .post(`${MEDIA}/part`, scope("write"), media((_repoId, oid, record, input) => this.leasePart(oid, record, input)))
      .post(`${MEDIA}/accept`, scope("write"), media((_repoId, oid, record, input) => this.settlePart(oid, record, input, true)))
      .post(`${MEDIA}/cancel`, scope("write"), media((_repoId, oid, record, input) => this.settlePart(oid, record, input, false)))
      .post(`${MEDIA}/complete`, scope("write"), media((repoId, oid, record) => this.completeUpload(repoId, oid, record)))
      .post(`${MEDIA}/checkpoint`, scope("write"), media((repoId, oid, record, input) =>
        this.checkpoint(repoId, oid, record, input)))
      // Git and LFS batch requests keep their public URL so LFS actions link back to it.
      .use("/api/v3/git/:repo/*", active, scope("read", "write"), async (c, next) => {
        if (c.req.param("repo") !== `${c.get("repoId")}.git`) return c.text("Not found", 404);
        await next();
      })
      .post("/api/v3/git/:repo/info/lfs/objects/batch", (c) => handleLfsBatch(c.req.raw, this.objectBucket(), storage,
        c.get("repoId"), scopeOf(c) as GitScope, this.accounting))
      .get("/api/v3/git/:repo/info/refs", advertisedService, initialized, (c) =>
        advertiseGitRefs(this.objectBucket(), c.get("repoId"), c.req.query("service") as GitService))
      .post("/api/v3/git/:repo/git-upload-pack", initialized, (c) =>
        uploadGitPack(c.req.raw, this.objectBucket(), c.get("repoId")))
      .post("/api/v3/git/:repo/git-receive-pack", scope("write"), initialized, (c) => this.receivePack(c))
      .onError((error, c) => {
        // Git pack and object limits surface as RangeError from the storage adapters.
        if (error instanceof RangeError) return c.text(error.message, 413);
        throw error;
      });
  }

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

  private async receivePack(c: Context<Routes>): Promise<Response> {
    const storage = this.state.storage;
    const repoId = c.get("repoId");
    const accounting = this.accounting;
    const last = await storage.get<number>("lastPushFinishedAt") ?? 0;
    // B2 can order same-key versions incorrectly within one second.
    const delay = last + 1000 - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    await accounting?.settleHistory(repoId, await this.gitBytes(repoId));
    try {
      return await receiveGitPack(c.req.raw, this.objectBucket(), repoId,
        accounting ? bytes => accounting.reserveHistory(repoId, ownerOf(c), bytes) : undefined);
    } finally {
      await storage.put("lastPushFinishedAt", Date.now());
      await storage.put("gitGcPending", true);
      await scheduleGitMaintenance(storage, Date.now() + 60_000);
      await accounting?.settleHistory(repoId, await this.gitBytes(repoId));
    }
  }

  private async createUpload(repoId: string, oid: string, record: Record, input: any): Promise<Response> {
    if (input.length !== record.size) return new Response("Upload length mismatch", { status: 409 });
    if (!record.uploadId && !record.versionId) {
      record.uploadId = (await this.objectBucket().createMultipartUpload(lfsKey(repoId, oid))).uploadId;
      await this.state.storage.put(`lfs:${oid}`, record);
    }
    return json(record);
  }

  private async leasePart(oid: string, record: Record, input: any): Promise<Response> {
    const { offset, length } = input;
    if (record.verified || record.versionId || !record.uploadId || offset !== record.offset)
      return new Response("Upload offset mismatch", { status: 409 });
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_GIT_LFS_PART_BYTES ||
        offset + length > record.size || (length < MIN_TUS_PART_BYTES && offset + length !== record.size) ||
        (length === 0 && record.size !== 0)) return new Response("Invalid tus part length", { status: 400 });
    if (record.lease && record.lease.until > Date.now())
      return new Response("Upload part in progress", { status: 423, headers: { "Retry-After": "1" } });
    record.lease = { id: crypto.randomUUID(), until: Date.now() + 15 * 60_000, offset, length };
    await this.state.storage.put(`lfs:${oid}`, record);
    return json({ uploadId: record.uploadId, partNumber: record.partCount + 1, leaseId: record.lease.id });
  }

  /** Records an uploaded part's receipt, or releases the lease after a failed part. */
  private async settlePart(oid: string, record: Record, input: any, accepted: boolean): Promise<Response> {
    const storage = this.state.storage;
    if (!record.lease || input.leaseId !== record.lease.id) return new Response("Upload receipt changed", { status: 409 });
    if (accepted) {
      if (typeof input.etag !== "string" || input.etag.length > 256 || input.partNumber !== record.partCount + 1)
        return new Response("Invalid upload receipt", { status: 400 });
      await storage.put(partKey(oid, input.partNumber), { partNumber: input.partNumber, etag: input.etag });
      record.offset += record.lease.length; record.partCount++;
    }
    delete record.lease; await storage.put(`lfs:${oid}`, record); return json(record);
  }

  private async completeUpload(repoId: string, oid: string, record: Record): Promise<Response> {
    const storage = this.state.storage;
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
    record.versionId = object.versionId; await storage.put(`lfs:${oid}`, record); return json(record);
  }

  private async checkpoint(repoId: string, oid: string, record: Record, input: any): Promise<Response> {
    const storage = this.state.storage;
    const key = `lfs:${oid}`;
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
