import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { MAX_GIT_LFS_PART_BYTES } from "@beutl/core";
import { advertiseGitRefs, initializeGitRepository, isGitService, receiveGitPack, uploadGitPack, type GitService } from "./git-http";
import { S3GitObjectBucket, sha256Base64, type GitS3Environment } from "./s3-object-store";
import type { GitObjectBucket } from "./git-object-store";
import { databaseGitStorageAccounting, withGitDatabase, type GitDatabaseEnvironment, type GitStorageAccounting } from "./accounting";
import { cleanupLfs, handleLfsBatch, json, lfsKey, LFS_TOUCH_PRECISION_MS, MAX_LFS_PARTS, MIN_TUS_PART_BYTES,
  partKey, partPrefix, readJson, scheduleGitMaintenance, UPLOAD_LIFETIME_MS,
  type GitDurableStorage, type LfsPart, type LfsRecord } from "./lfs";
import { referencedLfsOids } from "./lfs-references";
import { ResumableSha256, type Sha256State } from "./resumable-sha256";
import type { GitScope } from "./tokens";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MEDIA = "/internal/git/media/:oid{[0-9a-f]{64}}";
const DELETION_GRACE_MS = 2 * 60 * 60 * 1000;
// Clients upload media before pushing the commits that point to it. The
// touch precision keeps the full period after an offer whose write was skipped.
const LFS_COLLECTION_GRACE_MS = 7 * 24 * 60 * 60 * 1000 + LFS_TOUCH_PRECISION_MS;
const LFS_COLLECTION_BATCH = 100;
type Environment = GitS3Environment & GitDatabaseEnvironment;
type Record = LfsRecord & { gcComplete?: boolean };
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
type Routes = { Variables: { repoId: string } };
// Only the Worker reaches this object. It verified the token and ownership, and
// it overwrites these headers on every request it forwards.
const scopeOf = (c: Context) => c.req.header("x-beutl-git-scope") ?? "";
const ownerOf = (c: Context) => c.req.header("x-beutl-git-owner-id")!;
type MediaAction = (repoId: string, oid: string, record: Record, input: any) => Promise<Response>;

function validHashState(state: unknown, length: number): boolean {
  try { new ResumableSha256(state as never, length); return true; }
  catch {
    // The constructor rejects any state that cannot describe `length` bytes.
    return false;
  }
}

const sameHashState = (a: Sha256State | undefined, b: Sha256State | undefined) =>
  a === undefined || b === undefined ? a === b : a.tail === b.tail && a.words.every((word, i) => word === b.words[i]);

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
      .post(`${MEDIA}/accept`, scope("write"), media((repoId, oid, record, input) => this.settlePart(repoId, oid, record, input, true)))
      .post(`${MEDIA}/cancel`, scope("write"), media((repoId, oid, record, input) => this.settlePart(repoId, oid, record, input, false)))
      .post(`${MEDIA}/complete`, scope("write"), media((repoId, oid, record) => this.completeUpload(repoId, oid, record)))
      .post(`${MEDIA}/verify`, scope("write"), media((repoId, oid, record, input) =>
        this.verifyUpload(repoId, oid, record, input), { resource: false }))
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
    // tus treats an empty upload as finished once it is created.
    if (record.size === 0) {
      if (record.verified) return json(record);
      if (oid !== EMPTY_SHA256) {
        await cleanupLfs(this.state.storage, this.objectBucket(), this.accounting, repoId, oid, record);
        return new Response("LFS SHA-256 mismatch", { status: 422 });
      }
      record.digest = oid;
      return this.publish(repoId, oid, record, async () => {
        await this.objectBucket().put(lfsKey(repoId, oid), new Uint8Array());
        return this.objectBucket().head(lfsKey(repoId, oid));
      });
    }
    if (!record.uploadId && !record.versionId) {
      record.uploadId = (await this.objectBucket().createMultipartUpload(lfsKey(repoId, oid))).uploadId;
      await this.state.storage.put(`lfs:${oid}`, record);
    }
    return json(record);
  }

  /** Leases the next part to one PATCH and hands it the SHA-256 state at its offset. */
  private async leasePart(oid: string, record: Record, input: any): Promise<Response> {
    const { offset, length } = input;
    if (record.verified || record.versionId || !record.uploadId) return new Response("Upload offset mismatch", { status: 409 });
    if (record.parallel || input.start !== undefined) return this.leaseParallelPart(oid, record, input);
    if (offset !== record.offset) return new Response("Upload offset mismatch", { status: 409 });
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_GIT_LFS_PART_BYTES ||
        offset + length > record.size || (length < MIN_TUS_PART_BYTES && offset + length !== record.size))
      return new Response("Invalid tus part length", { status: 400 });
    if (record.partCount + 1 >= MAX_LFS_PARTS && offset + length !== record.size)
      return new Response("The upload needs larger parts to fit in 10,000", { status: 400 });
    if (record.lease && record.lease.until > Date.now())
      return new Response("Upload part in progress", { status: 423, headers: { "Retry-After": "1" } });
    record.lease = { id: crypto.randomUUID(), until: Date.now() + 15 * 60_000, offset, length };
    await this.state.storage.put(`lfs:${oid}`, record);
    return json({ uploadId: record.uploadId, partNumber: record.partCount + 1, leaseId: record.lease.id, hash: record.hash });
  }

  /** Records an uploaded part's receipt and hash state, or releases the lease after a failed part. */
  private async settlePart(repoId: string, oid: string, record: Record, input: any, accepted: boolean): Promise<Response> {
    const storage = this.state.storage;
    if (record.parallel) return this.settleParallelPart(repoId, oid, record, input, accepted);
    if (!record.lease || input.leaseId !== record.lease.id) return new Response("Upload receipt changed", { status: 409 });
    if (accepted) {
      const offset = record.offset + record.lease.length;
      const complete = offset === record.size;
      if (typeof input.etag !== "string" || input.etag.length > 256 || input.partNumber !== record.partCount + 1 ||
          (complete ? !/^[0-9a-f]{64}$/u.test(input.digest) : !validHashState(input.hash, offset)))
        return new Response("Invalid upload receipt", { status: 400 });
      await storage.put(partKey(oid, input.partNumber), { partNumber: input.partNumber, etag: input.etag });
      record.offset = offset; record.partCount++;
      if (complete) { record.digest = input.digest; delete record.hash; } else record.hash = input.hash;
      await this.extendReservation(repoId, oid, record);
    }
    delete record.lease; await storage.put(`lfs:${oid}`, record); return json(record);
  }

  /** A large upload can outlast one lifetime; progress keeps its reservation. */
  private async extendReservation(repoId: string, oid: string, record: Record): Promise<void> {
    if (record.expiresAt - Date.now() >= UPLOAD_LIFETIME_MS / 2) return;
    record.expiresAt = Date.now() + UPLOAD_LIFETIME_MS;
    await this.accounting?.extendLfs(repoId, oid, record.expiresAt).catch((error) =>
      // This record decides expiry; a stale account row only makes cron ask again.
      console.error("Git LFS reservation extension failed", { repoId, oid, error }));
  }

  /**
   * Leases one 32 MiB part of a parallel upload, numbered by its offset. The
   * part at the accepted offset continues the recorded SHA-256 state; a later
   * part starts from the state its client names, which settleParallelPart
   * checks once the accepted offset reaches it.
   */
  private async leaseParallelPart(oid: string, record: Record, input: any): Promise<Response> {
    const storage = this.state.storage;
    const { offset, length } = input;
    // Every part before the accepted offset is full, so offsets name part numbers.
    if (!Number.isSafeInteger(offset) || offset % MAX_GIT_LFS_PART_BYTES !== 0 || offset < record.offset ||
        offset >= record.size || record.offset !== record.partCount * MAX_GIT_LFS_PART_BYTES)
      return new Response("Upload offset mismatch", { status: 409 });
    if (length !== Math.min(MAX_GIT_LFS_PART_BYTES, record.size - offset))
      return new Response("Parallel tus parts hold 32 MiB, except the last", { status: 400 });
    if (offset > record.offset && !validHashState(input.start, offset))
      return new Response("Invalid SHA-256 state", { status: 400 });
    if (record.lease && record.lease.until > Date.now())
      return new Response("Upload part in progress", { status: 423, headers: { "Retry-After": "1" } });
    const partNumber = offset / MAX_GIT_LFS_PART_BYTES + 1;
    const key = partKey(oid, partNumber);
    const part = await storage.get<LfsPart>(key) ?? { partNumber };
    if (part.lease && part.lease.until > Date.now())
      return new Response("Upload part in progress", { status: 423, headers: { "Retry-After": "1" } });
    const start: Sha256State | undefined = offset === record.offset ? record.hash : input.start;
    // A failed re-upload leaves B2's earlier copy of the part, so its receipt stays until replaced.
    part.lease = { id: crypto.randomUUID(), until: Date.now() + 15 * 60_000, ...(start ? { start } : {}) };
    await storage.put(key, part);
    if (!record.parallel) { record.parallel = true; delete record.lease; await storage.put(`lfs:${oid}`, record); }
    return json({ uploadId: record.uploadId, partNumber, leaseId: part.lease.id, hash: start });
  }

  /**
   * Records a parallel part's receipt, or releases its lease after a failure,
   * then moves the accepted offset over every following part already stored. A
   * part whose named start differs from the state the bytes before it reached
   * cannot belong to this object, so the upload is discarded.
   */
  private async settleParallelPart(repoId: string, oid: string, record: Record, input: any, accepted: boolean): Promise<Response> {
    const storage = this.state.storage;
    const key = Number.isSafeInteger(input.partNumber) ? partKey(oid, input.partNumber) : "";
    const part = key ? await storage.get<LfsPart>(key) : undefined;
    if (!part?.lease || input.leaseId !== part.lease.id) return new Response("Upload receipt changed", { status: 409 });
    const { start } = part.lease;
    delete part.lease;
    if (!accepted) {
      if (part.etag) await storage.put(key, part); else await storage.delete(key);
    } else if (part.partNumber <= record.partCount) {
      // The lease expired and the accepted offset passed the earlier receipt,
      // whose digest the record now holds; B2 completion checks its ETag.
      await storage.put(key, part);
      return new Response("Upload receipt changed", { status: 409 });
    } else {
      const length = Math.min(MAX_GIT_LFS_PART_BYTES, record.size - (part.partNumber - 1) * MAX_GIT_LFS_PART_BYTES);
      const end = (part.partNumber - 1) * MAX_GIT_LFS_PART_BYTES + length;
      if (typeof input.etag !== "string" || input.etag.length > 256 ||
          (end === record.size ? !/^[0-9a-f]{64}$/u.test(input.digest) : !validHashState(input.hash, end)))
        return new Response("Invalid upload receipt", { status: 400 });
      await storage.put<LfsPart>(key, { partNumber: part.partNumber, etag: input.etag, length,
        ...(start ? { start } : {}), ...(end === record.size ? { digest: input.digest } : { end: input.hash }) });
    }
    // A part being sent again is passed only once that upload settles: its
    // bytes may replace the stored part, and the receipt must match them.
    for (let next = await storage.get<LfsPart>(partKey(oid, record.partCount + 1));
      next?.etag && next.length && !(next.lease && next.lease.until > Date.now());
      next = await storage.get<LfsPart>(partKey(oid, record.partCount + 1))) {
      if (!sameHashState(next.start, record.hash)) {
        await cleanupLfs(storage, this.objectBucket(), this.accounting, repoId, oid, record);
        return new Response("LFS SHA-256 mismatch", { status: 422 });
      }
      record.offset += next.length; record.partCount++;
      if (record.offset === record.size) { record.digest = next.digest; delete record.hash; } else record.hash = next.end;
    }
    if (accepted) await this.extendReservation(repoId, oid, record);
    await storage.put(`lfs:${oid}`, record); return json(record);
  }

  /**
   * Publishes a tus upload once every byte arrived. The PATCH requests hashed
   * the bytes they stored, so a wrong digest discards the upload before B2
   * assembles it.
   */
  private async completeUpload(repoId: string, oid: string, record: Record): Promise<Response> {
    if (record.verified) return json(record);
    if (record.offset !== record.size || !record.uploadId || record.partCount === 0 || !record.digest)
      return new Response("Upload incomplete", { status: 409 });
    if (record.digest !== oid) {
      await cleanupLfs(this.state.storage, this.objectBucket(), this.accounting, repoId, oid, record);
      return new Response("LFS SHA-256 mismatch", { status: 422 });
    }
    return this.publish(repoId, oid, record, async () => {
      // A completion whose response was lost has already assembled the object.
      const existing = await this.objectBucket().head(lfsKey(repoId, oid));
      if (existing?.size === record.size) return existing;
      // Every part up to the accepted offset has a receipt.
      const parts = [...(await this.state.storage.list<LfsPart>({ prefix: partPrefix(oid) })).values()]
        .filter(p => p.partNumber <= record.partCount).sort((a, b) => a.partNumber - b.partNumber)
        .map(({ partNumber, etag }) => ({ partNumber, etag: etag! }));
      return this.objectBucket().resumeMultipartUpload(lfsKey(repoId, oid), record.uploadId!).complete(parts);
    });
  }

  /** Pins the stored version, commits the account reservation and marks the object verified. */
  private async publish(repoId: string, oid: string, record: Record,
    store: () => Promise<{ size: number; versionId?: string } | null>): Promise<Response> {
    const storage = this.state.storage;
    const object = await store();
    if (!object?.versionId || object.size !== record.size) throw new Error("B2 completion has no pinned version");
    await this.accounting?.commitLfs(repoId, oid);
    record.versionId = object.versionId; record.verified = true; record.touchedAt = Date.now();
    delete record.hash; delete record.lease;
    await storage.put(`lfs:${oid}`, record);
    const parts = await storage.list({ prefix: partPrefix(oid) });
    if (parts.size) await storage.delete([...parts.keys()]);
    await scheduleGitMaintenance(storage, Date.now() + 60_000);
    return json(record);
  }

  /**
   * Publishes an object a basic-transfer client PUT to its presigned URL. B2
   * stores such a PUT only when its length and SHA-256 match the LFS object, and
   * keeps that checksum; tus objects have none and are verified by hashing.
   */
  private async verifyUpload(repoId: string, oid: string, record: Record, input: any): Promise<Response> {
    if (input.size !== record.size) return new Response("LFS size differs from its reservation", { status: 422 });
    if (record.verified) return json(record);
    const object = await this.objectBucket().head(lfsKey(repoId, oid), undefined, { checksum: true });
    if (!object?.versionId || object.size !== record.size || object.checksumSha256 !== sha256Base64(oid))
      return new Response("LFS object has not been uploaded", { status: 404 });
    return this.publish(repoId, oid, record, async () => object);
  }

  /**
   * Deletes verified LFS objects that no branch or tag points to anywhere in
   * its history. An object becomes a candidate only after a grace period
   * without an upload or upload batch. Returns whether candidates remain.
   */
  private async collectUnreferencedLfs(repoId: string): Promise<boolean> {
    const storage = this.state.storage;
    const now = Date.now();
    const checkedAt = await storage.get<number>("lfsCollectionCheckedAt") ?? 0;
    // References change only with a push, so a candidate that was referenced at
    // the last check still is unless a push happened since.
    let changed = (await storage.get<number>("lastPushFinishedAt") ?? 0) > checkedAt;
    const candidates: [string, Record][] = [];
    for (const [key, record] of await storage.list<Record>({ prefix: "lfs:" })) {
      if (!record.verified) continue;
      // Objects published before collection existed start their grace period now.
      if (record.touchedAt === undefined) { await storage.put(key, { ...record, touchedAt: now }); continue; }
      if (record.touchedAt + LFS_COLLECTION_GRACE_MS > now) continue;
      candidates.push([key, record]);
      if (record.touchedAt + LFS_COLLECTION_GRACE_MS > checkedAt) changed = true;
    }
    if (!candidates.length || !changed) return false;
    const referenced = await referencedLfsOids(this.objectBucket(), repoId);
    const unreferenced = candidates.filter(([key]) => !referenced.has(key.slice(4)));
    for (const [key, record] of unreferenced.slice(0, LFS_COLLECTION_BATCH)) {
      // Unpublish first; if deletion stops halfway, the expired reservation is
      // cleaned up like an abandoned upload.
      const abandoned = { ...record, verified: false, expiresAt: 0 };
      await storage.put(key, abandoned);
      await cleanupLfs(storage, this.objectBucket(), this.accounting, repoId, key.slice(4), abandoned);
    }
    if (unreferenced.length) console.info("Git LFS objects collected", { repoId, count: Math.min(unreferenced.length, LFS_COLLECTION_BATCH) });
    if (unreferenced.length > LFS_COLLECTION_BATCH) return true;
    await storage.put("lfsCollectionCheckedAt", now);
    return false;
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
      if (Date.now() >= (await storage.get<number>("lfsCollectionAt") ?? 0)) {
        let next = Date.now() + UPLOAD_LIFETIME_MS;
        try { if (await this.collectUnreferencedLfs(repoId)) next = Date.now() + 60_000; }
        catch (error) {
          // Nothing was deleted on the strength of a partial history; try again later.
          next = Date.now() + 60 * 60_000;
          console.error("Git LFS collection failed", { repoId, error });
        }
        await storage.put("lfsCollectionAt", next);
        await scheduleGitMaintenance(storage, next);
      }
      await scheduleGitMaintenance(storage, Date.now() + (records.size === 50 || failed ? 60_000 : UPLOAD_LIFETIME_MS));
    });
  }
}
