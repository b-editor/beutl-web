import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { cacheGitObjectStore } from "./cached-object-store";
import { MAX_GIT_LFS_PART_BYTES } from "@beutl/core";
import { advertiseGitRefs, gitRepositoryPrefix, initializeGitRepository, isGitService, MAX_GIT_REPOSITORY_BYTES, readGitRepository, receiveGitPack,
  uploadGitPack, type GitService } from "./git-http";
import { isGitRevision, isGitTreePath } from "@beutl/core";
import { browseFile, browseLog, browsePath, browseRefs, GitBrowseNotFoundError, MAX_COMMIT_PAGE } from "./browse";
import { S3GitObjectBucket, sha256Base64, type GitS3Environment } from "./s3-object-store";
import { GitObjectStore, type GitObjectBucket, type ListResult, type ObjectStore } from "./git-object-store";
import { databaseGitStorageAccounting, withGitDatabase, type GitDatabaseEnvironment, type GitStorageAccounting } from "./accounting";
import { cleanupLfs, handleLfsBatch, json, lfsKey, LFS_TOUCH_PRECISION_MS, MAX_LFS_PARTS, MIN_TUS_PART_BYTES,
  partKey, partPrefix, readJson, scheduleGitMaintenance, UPLOAD_LIFETIME_MS,
  type GitDurableStorage, type LfsPart, type LfsRecord } from "./lfs";
import { collectUnreachableHistory } from "./history-collection";
import { referencedLfsOids } from "./lfs-references";
import { ResumableSha256, type Sha256State } from "./resumable-sha256";
import type { GitScope } from "./tokens";
import { resolveWorkerSecrets, S3_SECRET_NAMES, type WorkerSecretBindings } from "../worker-secrets";
import { gitRepositoryThumbnailPrefix } from "./thumbnails";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MEDIA = "/internal/git/media/:oid{[0-9a-f]{64}}";
const MEDIA_ROUTE = /^\/internal\/git\/(media|lfs-cleanup)\/([0-9a-f]{64})(?:\/|$)/u;
const LFS_BATCH_ROUTE = /^\/api\/v3\/git\/[^/]+\.git\/info\/lfs\/objects\/batch$/u;
const DELETION_GRACE_MS = 2 * 60 * 60 * 1000;
const BROWSE = "/internal/git/browse/";
// Smart HTTP and browse share cached reads. Maintenance uses the bucket directly.
const REPO_CACHE_TTL_MS = 5 * 60_000;
// Clients upload media before pushing the commits that point to it. The
// touch precision keeps the full period after an offer whose write was skipped.
const LFS_COLLECTION_GRACE_MS = 7 * 24 * 60 * 60 * 1000 + LFS_TOUCH_PRECISION_MS;
const LFS_COLLECTION_BATCH = 100;
type Environment = GitS3Environment & GitDatabaseEnvironment;
type Record = LfsRecord & { gcComplete?: boolean };
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
type Routes = { Variables: { repoId: string; initializedObjects?: ListResult["objects"] } };
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

const uploadOffsetMismatch = (offset: number) =>
  new Response("Upload offset mismatch", { status: 409, headers: { "Upload-Offset": String(offset) } });

/** Serializes Git metadata and per-OID media receipts; media bodies stay in the Worker. */
export class GitRepositoryDurableObject {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly mediaQueues = new Map<string, Promise<unknown>>();
  private lfsCountTail: Promise<unknown> = Promise.resolve();
  private deleting = false;
  private boundRepoId?: string;
  private bucket?: GitObjectBucket;
  private resolvedEnv?: Environment;
  private repoCache?: { repoId: string; store: ObjectStore };
  private readonly accounting?: GitStorageAccounting;
  private readonly app: Hono<Routes>;
  constructor(private readonly state: { storage: GitDurableStorage; waitUntil?(promise: Promise<unknown>): void },
    private readonly env: WorkerSecretBindings<Environment>,
    bucket?: GitObjectBucket, accounting?: GitStorageAccounting) {
    this.bucket = bucket;
    this.accounting = accounting ?? (bucket ? undefined : databaseGitStorageAccounting);
    this.app = this.routes();
  }
  private objectBucket(): GitObjectBucket { return this.bucket ??= new S3GitObjectBucket(this.resolvedEnv!); }
  private async resolveStorageEnvironment(): Promise<Environment> {
    const env = await resolveWorkerSecrets<Environment>(this.env, S3_SECRET_NAMES);
    if (this.resolvedEnv && S3_SECRET_NAMES.some((key) => this.resolvedEnv![key] !== env[key])) {
      this.bucket = undefined;
      this.repoCache = undefined;
    }
    this.resolvedEnv = env;
    return env;
  }
  private async ensureBucket(): Promise<GitObjectBucket> {
    await this.resolveStorageEnvironment();
    return this.objectBucket();
  }
  private withCountLock<T>(work: () => Promise<T>): Promise<T> {
    const result = this.lfsCountTail.then(work);
    this.lfsCountTail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async runWithBindings<T>(work: () => Promise<T>, resolveStorage: boolean): Promise<T> {
    const env = resolveStorage ? await this.resolveStorageEnvironment() : this.env;
    return this.accounting === databaseGitStorageAccounting
      ? withGitDatabase(env, work, undefined, this.state.waitUntil?.bind(this.state))
      : work();
  }
  private enqueue<T>(work: () => Promise<T>, { resolveStorage = true } = {}): Promise<T> {
    const result = this.tail.then(() => this.runWithBindings(work, resolveStorage));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  /** Serializes work for one LFS OID without opening a nested DB context. */
  private serializeOid<T>(oid: string, work: () => Promise<T>): Promise<T> {
    const previous = this.mediaQueues.get(oid) ?? Promise.resolve();
    const result = previous.then(work);
    const settled = result.then(() => undefined, () => undefined);
    this.mediaQueues.set(oid, settled);
    void settled.then(() => {
      if (this.mediaQueues.get(oid) === settled) this.mediaQueues.delete(oid);
    });
    return result;
  }
  /** Serializes operations for one LFS OID while letting distinct objects run concurrently. */
  private enqueueMedia<T>(oid: string, work: () => Promise<T>, { resolveStorage = false } = {}): Promise<T> {
    return this.serializeOid(oid, () => this.runWithBindings(work, resolveStorage));
  }
  private async drainMediaQueues(): Promise<void> {
    while (this.mediaQueues.size > 0) {
      await Promise.allSettled([...this.mediaQueues.values()]);
    }
  }
  private async waitForMediaOids(oids: string[]): Promise<void> {
    const active = oids.map((oid) => this.mediaQueues.get(oid)).filter((pending): pending is Promise<unknown> => pending !== undefined);
    if (active.length) await Promise.allSettled(active);
  }
  fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const mediaMatch = MEDIA_ROUTE.exec(pathname);
    if (mediaMatch) {
      if (mediaMatch[1] === "media" && this.deleting) {
        return Promise.resolve(new Response("Repository deleted", { status: 410 }));
      }
      return this.enqueueMedia(mediaMatch[2], async () => this.app.fetch(request), { resolveStorage: mediaMatch[1] === "lfs-cleanup" });
    }
    const resolveStorage = !LFS_BATCH_ROUTE.test(pathname);
    return this.enqueue(async () => this.app.fetch(request), { resolveStorage });
  }

  private routes(): Hono<Routes> {
    const storage = this.state.storage;
    const scope = (...allowed: string[]) => createMiddleware<Routes>(async (c, next) => {
      if (!allowed.includes(scopeOf(c))) return c.text("Forbidden", 403);
      await next();
    });
    const active = createMiddleware<Routes>(async (c, next) => {
      if (this.deleting || await storage.get<number>("deletedAt") !== undefined) return c.text("Repository deleted", 410);
      await next();
    });
    // Bare-repository HEAD/config also consume account storage. Reserve the
    // initial allocation before creating these metadata objects.
    const initialized = createMiddleware<Routes>(async (c, next) => {
      if (await storage.get<boolean>("gitInitialized") === true) return next();
      if (!this.accounting) {
        await next();
        if (c.res.ok) await storage.put("gitInitialized", true);
        return;
      }
      const repoId = c.get("repoId");
      const empty = await this.gitBytes(repoId) === 0;
      if (empty && !await this.reserveHistory(repoId, ownerOf(c), 4096))
        return c.text("Account storage quota exceeded", 413);
      let needsSettlement = empty || await storage.get<boolean>("historyUnsettled") === true;
      let initial: Awaited<ReturnType<typeof initializeGitRepository>> | undefined;
      try {
        initial = await initializeGitRepository(this.objectBucket(), repoId, { store: this.repoStore(repoId) }, async () => {
          // A previous initialization can have stored just one of HEAD/config.
          if (!needsSettlement) {
            await storage.put("historyUnsettled", true);
            needsSettlement = true;
          }
          await this.waitForGitWrite();
        });
      } finally {
        if (needsSettlement) await this.settleHistory(repoId, initial?.bytes);
      }
      c.set("initializedObjects", initial.objects);
      await storage.put("gitInitialized", true);
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
        const bound = this.boundRepoId ?? await storage.get<string>("repoId");
        if (bound && bound !== repoId) return c.text("Repository mismatch", 403);
        if (!bound) await storage.put("repoId", repoId);
        this.boundRepoId = repoId;
        c.set("repoId", repoId);
        await next();
      })
      .post("/internal/git/history", scope("admin"), async (c) => {
        await this.settleHistory(c.get("repoId"));
        await storage.put("gitGcPending", true);
        await scheduleGitMaintenance(storage, Date.now() + 60_000);
        return c.body(null, 204);
      })
      .delete("/internal/git/cleanup", scope("admin"), async (c) => {
        this.repoCache = undefined;
        if (await storage.get<boolean>("cleanupComplete")) return c.body(null, 204);
        return c.body(null, await this.deleteRepository(c.get("repoId")) ? 204 : 202);
      })
      .post("/internal/git/lfs-cleanup/:oid{[0-9a-f]{64}}", scope("admin"), async (c) => {
        const repoId = c.get("repoId"), oid = c.req.param("oid");
        const r = await storage.get<Record>(`lfs:${oid}`);
        if (r?.verified) await this.accounting?.commitLfs(repoId, oid);
        else if (!r || r.expiresAt <= Date.now()) {
          await cleanupLfs(storage, this.objectBucket(), this.accounting, repoId, oid, r, (work) => this.withCountLock(work));
        }
        return c.body(null, 204);
      })
      // Read-only views for the dashboard, whose Worker already checked the owner.
      .use(`${BROWSE}*`, active, scope("read", "write"))
      // Refs and HEAD are small files of their own; no pack needs loading.
      .get(`${BROWSE}refs`, async (c) => json(await browseRefs(this.browseRepository(c.get("repoId")))))
      .get(`${BROWSE}path`, async (c) => {
        const ref = c.req.query("ref") ?? "", path = c.req.query("path") ?? "";
        if (!isGitRevision(ref) || !isGitTreePath(path)) return c.text("Invalid ref or path", 400);
        return json(await browsePath(await this.browsable(c.get("repoId")), ref, path));
      })
      .get(`${BROWSE}log`, async (c) => {
        const ref = c.req.query("ref") ?? "", cursor = c.req.query("cursor");
        if (!isGitRevision(ref) || (cursor !== undefined && !/^[0-9a-f]{40}$/u.test(cursor)))
          return c.text("Invalid ref or cursor", 400);
        return json(await browseLog(await this.browsable(c.get("repoId")), ref, cursor, MAX_COMMIT_PAGE));
      })
      .get(`${BROWSE}file`, async (c) => {
        const ref = c.req.query("ref") ?? "", path = c.req.query("path") ?? "";
        if (!isGitRevision(ref) || !isGitTreePath(path) || path === "") return c.text("Invalid ref or path", 400);
        const { entry, response } = await browseFile(await this.browsable(c.get("repoId")), ref, path,
          { method: c.req.method, range: c.req.header("range") });
        // The entry rides along so the Worker needs no second lookup; names may be any Unicode.
        const headers = new Headers(response.headers);
        for (const [name, value] of Object.entries({
          "Content-Type": "application/octet-stream", "Cache-Control": "no-store",
          "x-beutl-git-entry": encodeURIComponent(JSON.stringify(entry)),
        })) headers.set(name, value);
        return new Response(response.body, { status: response.status, headers });
      })
      .use("/internal/git/media/*", active, scope("read", "write"))
      .get(`${MEDIA}/status`, async (c) => {
        const record = await reservation(c);
        return record instanceof Response ? record : json(record);
      })
      .post(`${MEDIA}/create`, scope("write"), media((repoId, oid, record, input) =>
        this.createUpload(repoId, oid, record, input), { resource: false }))
      .post(`${MEDIA}/part`, scope("write"), media((repoId, oid, record, input) => this.leasePart(repoId, oid, record, input)))
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
      .post("/api/v3/git/:repo/info/lfs/objects/batch", (c) => handleLfsBatch(c.req.raw, () => this.ensureBucket(), storage,
        c.get("repoId"), scopeOf(c) as GitScope, this.accounting, {
          waitForOids: (oids) => this.waitForMediaOids(oids),
          runForOid: (oid, work) => this.serializeOid(oid, work),
          withCountLock: (work) => this.withCountLock(work),
        }))
      .get("/api/v3/git/:repo/info/refs", advertisedService, initialized, (c) =>
        advertiseGitRefs(this.objectBucket(), c.get("repoId"), c.req.query("service") as GitService, this.repositoryOptions(c)))
      .post("/api/v3/git/:repo/git-upload-pack", initialized, (c) =>
        uploadGitPack(c.req.raw, this.objectBucket(), c.get("repoId"), this.repositoryOptions(c)))
      .post("/api/v3/git/:repo/git-receive-pack", scope("write"), initialized, (c) => this.receivePack(c))
      .onError((error, c) => {
        if (error instanceof GitBrowseNotFoundError) return c.text("Not found", 404);
        // Git pack and object limits surface as RangeError from the storage adapters.
        if (error instanceof RangeError) return c.text(error.message, 413);
        throw error;
      });
  }

  private repoStore(repoId: string): ObjectStore {
    if (this.repoCache?.repoId !== repoId) {
      this.repoCache = { repoId, store: cacheGitObjectStore(new GitObjectStore(this.objectBucket()), {
        maxBytes: 2 * MAX_GIT_REPOSITORY_BYTES, ttlMs: REPO_CACHE_TTL_MS,
      }) };
    }
    return this.repoCache.store;
  }

  private repositoryOptions(c: Context<Routes>) {
    const objects = c.get("initializedObjects");
    return { store: this.repoStore(c.get("repoId")), objects, initialized: objects !== undefined };
  }

  private browseRepository(repoId: string) {
    return readGitRepository(this.objectBucket(), repoId, { store: this.repoStore(repoId), looseObjectHints: true });
  }

  /** Learn which loose-object probes can be skipped; load packs only when a view needs them. */
  private async browsable(repoId: string) {
    const opened = this.browseRepository(repoId);
    // Also learns whether any loose objects exist, so reads stop looking for them.
    await opened.fs.detectLooseObjects(opened.repo.gitdir);
    return opened;
  }

  private async gitBytes(repoId: string, store = this.repoStore(repoId)): Promise<number> {
    const { objects } = await store.list(`${gitRepositoryPrefix(repoId)}/`);
    return objects.reduce((bytes, object) => bytes + object.size, 0);
  }
  private async settleHistory(repoId: string, bytes?: number): Promise<void> {
    if (!this.accounting) return;
    await this.accounting.settleHistory(repoId, bytes ?? await this.gitBytes(repoId));
    await this.state.storage.delete("historyUnsettled");
  }
  private async reserveHistory(repoId: string, ownerId: string, bytes: number): Promise<boolean> {
    const storage = this.state.storage, accounting = this.accounting!;
    await storage.put("historyUnsettled", true);
    let reserved: boolean;
    try { reserved = await accounting.reserveHistory(repoId, ownerId, bytes); }
    catch (error) {
      // Older objects can have a stranded DB reservation without a local flag.
      if (!(error instanceof Error) || error.message !== "Git history requires reconciliation") throw error;
      await accounting.settleHistory(repoId, await this.gitBytes(repoId));
      reserved = await accounting.reserveHistory(repoId, ownerId, bytes);
    }
    if (!reserved) await storage.delete("historyUnsettled");
    return reserved;
  }
  private async deleteRepository(repoId: string): Promise<boolean> {
    this.deleting = true;
    this.repoCache = undefined;
    const storage = this.state.storage;
    let deletedAt = await storage.get<number>("deletedAt");
    if (deletedAt === undefined) { deletedAt = Date.now(); await storage.put("deletedAt", deletedAt); }
    await this.drainMediaQueues();
    await storage.delete(["gitInitialized", "historyUnsettled", "lfsCount"]);
    const bucket = this.objectBucket();
    await bucket.cleanupMultipartUploads?.(`git-lfs/repos/${repoId}/`, [], Infinity);
    await bucket.deletePrefix?.(`${gitRepositoryPrefix(repoId)}/`);
    await bucket.deletePrefix?.(`git-lfs/repos/${repoId}/`);
    await bucket.deletePrefix?.(gitRepositoryThumbnailPrefix(repoId));
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

  private async waitForGitWrite(): Promise<void> {
    const last = await this.state.storage.get<number>("lastPushFinishedAt");
    if (last === undefined) return;
    // B2 can order same-key versions incorrectly within one second.
    const delay = last + 1000 - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }

  private async receivePack(c: Context<Routes>): Promise<Response> {
    const storage = this.state.storage, repoId = c.get("repoId"), accounting = this.accounting;
    if (accounting && await storage.get<boolean>("historyUnsettled")) await this.settleHistory(repoId);
    let reserved = false, writeStarted = false, settledBytes: number | undefined;
    const reserve = accounting ? async (bytes: number) => reserved = await this.reserveHistory(repoId, ownerOf(c), bytes) : undefined;
    try {
      return await receiveGitPack(c.req.raw, this.objectBucket(), repoId, reserve, {
        ...this.repositoryOptions(c),
        beforeWrite: async () => {
          // Ref-only writes can change the total without needing a quota reservation.
          if (accounting && !reserved) await storage.put("historyUnsettled", true);
          await this.waitForGitWrite();
          writeStarted = true;
        },
        onSettled: ({ wrote, bytes }) => { if (wrote) settledBytes = bytes; },
      });
    } finally {
      if (writeStarted) {
        const finishedAt = Date.now();
        await storage.put("lastPushFinishedAt", finishedAt);
        await storage.put("gitGcPending", true);
        await scheduleGitMaintenance(storage, finishedAt + 60_000);
      }
      if (settledBytes !== undefined) await this.settleHistory(repoId, settledBytes);
      else if (accounting && await storage.get<boolean>("historyUnsettled")) await this.settleHistory(repoId);
    }
  }

  private async createUpload(repoId: string, oid: string, record: Record, input: any): Promise<Response> {
    if (input.length !== record.size) return new Response("Upload length mismatch", { status: 409 });
    // tus treats an empty upload as finished once it is created.
    if (record.size === 0) {
      if (record.verified) return json(record);
      if (oid !== EMPTY_SHA256) {
        await cleanupLfs(this.state.storage, await this.ensureBucket(), this.accounting, repoId, oid, record,
          (work) => this.withCountLock(work));
        return new Response("LFS SHA-256 mismatch", { status: 422 });
      }
      record.digest = oid;
      return this.publish(repoId, oid, record, async () => {
        const bucket = await this.ensureBucket();
        const stored = await bucket.put(lfsKey(repoId, oid), new Uint8Array());
        const versionId = stored && typeof stored === "object" && "versionId" in stored && typeof stored.versionId === "string"
          ? stored.versionId : undefined;
        return versionId ? { size: 0, versionId } : bucket.head(lfsKey(repoId, oid));
      });
    }
    // Objects up to 32 MiB can finish in one checksum-pinned PUT without a B2
    // multipart round trip. Larger objects always need a multipart upload ID.
    if (record.size > MAX_GIT_LFS_PART_BYTES && !record.uploadId && !record.versionId) {
      record.uploadId = (await (await this.ensureBucket()).createMultipartUpload(lfsKey(repoId, oid))).uploadId;
      await this.state.storage.put(`lfs:${oid}`, record);
    }
    return json(record);
  }

  /** Leases the next part to one PATCH and hands it the SHA-256 state at its offset. */
  private async leasePart(repoId: string, oid: string, record: Record, input: any): Promise<Response> {
    const { offset, length } = input;
    if (record.verified || record.versionId || (input.start === undefined && offset !== record.offset))
      return uploadOffsetMismatch(record.offset);
    if (!record.uploadId && !record.parallel && input.singlePut === true &&
        offset === 0 && length === record.size && record.size <= MAX_GIT_LFS_PART_BYTES) {
      if (record.lease && record.lease.until > Date.now())
        return new Response("Upload part in progress", { status: 423, headers: { "Retry-After": "1" } });
      record.lease = { id: crypto.randomUUID(), until: Date.now() + 15 * 60_000, offset: 0, length };
      await this.state.storage.put(`lfs:${oid}`, record);
      return json({ mode: "single", leaseId: record.lease.id, size: record.size });
    }
    if (record.parallel || input.start !== undefined) return this.leaseParallelPart(repoId, oid, record, input);
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_GIT_LFS_PART_BYTES ||
        offset + length > record.size || (length < MIN_TUS_PART_BYTES && offset + length !== record.size))
      return new Response("Invalid tus part length", { status: 400 });
    if (record.partCount + 1 >= MAX_LFS_PARTS && offset + length !== record.size)
      return new Response("The upload needs larger parts to fit in 10,000", { status: 400 });
    if (record.lease && record.lease.until > Date.now())
      return new Response("Upload part in progress", { status: 423, headers: { "Retry-After": "1" } });
    if (!record.uploadId) {
      record.uploadId = (await (await this.ensureBucket()).createMultipartUpload(lfsKey(repoId, oid))).uploadId;
    }
    record.lease = { id: crypto.randomUUID(), until: Date.now() + 15 * 60_000, offset, length };
    await this.state.storage.put(`lfs:${oid}`, record);
    return json({ uploadId: record.uploadId, partNumber: record.partCount + 1, leaseId: record.lease.id, hash: record.hash,
      size: record.size });
  }

  /** Records an uploaded part's receipt and hash state, or releases the lease after a failed part. */
  private async settlePart(repoId: string, oid: string, record: Record, input: any, accepted: boolean): Promise<Response> {
    const storage = this.state.storage;
    if (input.singlePut === true) {
      if (!record.lease || input.leaseId !== record.lease.id) return new Response("Upload receipt changed", { status: 409 });
      delete record.lease;
      if (!accepted) {
        await storage.put(`lfs:${oid}`, record);
        return json(record);
      }
      if (typeof input.digest !== "string" || !/^[0-9a-f]{64}$/u.test(input.digest))
        return new Response("Invalid upload receipt", { status: 400 });
      if (input.digest !== oid) {
        await cleanupLfs(storage, await this.ensureBucket(), this.accounting, repoId, oid, record,
          (work) => this.withCountLock(work));
        return new Response("LFS SHA-256 mismatch", { status: 422 });
      }
      record.offset = record.size;
      record.digest = input.digest;
      const versionId = typeof input.versionId === "string" && input.versionId.length > 0 ? input.versionId : undefined;
      await this.extendReservation(repoId, oid, record);
      return this.publish(repoId, oid, record, async () =>
        versionId ? { size: record.size, versionId } : (await this.ensureBucket()).head(lfsKey(repoId, oid)));
    }
    if (record.parallel) return this.settleParallelPart(repoId, oid, record, input, accepted);
    if (!record.lease || input.leaseId !== record.lease.id) return new Response("Upload receipt changed", { status: 409 });
    if (accepted) {
      const offset = record.offset + record.lease.length;
      const complete = offset === record.size;
      if (typeof input.etag !== "string" || input.etag.length > 256 || input.partNumber !== record.partCount + 1 ||
          (complete ? !/^[0-9a-f]{64}$/u.test(input.digest) : !validHashState(input.hash, offset)))
        return new Response("Invalid upload receipt", { status: 400 });
      record.offset = offset; record.partCount++;
      if (complete) { record.digest = input.digest; delete record.hash; } else record.hash = input.hash;
      delete record.lease;
      await this.extendReservation(repoId, oid, record);
      await Promise.all([
        storage.put(partKey(oid, input.partNumber), { partNumber: input.partNumber, etag: input.etag }),
        storage.put(`lfs:${oid}`, record),
      ]);
      if (record.offset === record.size && !record.verified) return this.completeUpload(repoId, oid, record);
      return json(record);
    }
    delete record.lease;
    await storage.put(`lfs:${oid}`, record);
    return json(record);
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
  private async leaseParallelPart(repoId: string, oid: string, record: Record, input: any): Promise<Response> {
    const storage = this.state.storage;
    const { offset, length } = input;
    // Every part before the accepted offset is full, so offsets name part numbers.
    if (!Number.isSafeInteger(offset) || offset % MAX_GIT_LFS_PART_BYTES !== 0 || offset < record.offset ||
        offset >= record.size || record.offset !== record.partCount * MAX_GIT_LFS_PART_BYTES)
      return uploadOffsetMismatch(record.offset);
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
    let recordChanged = false;
    if (!record.uploadId) {
      record.uploadId = (await (await this.ensureBucket()).createMultipartUpload(lfsKey(repoId, oid))).uploadId;
      recordChanged = true;
    }
    const start: Sha256State | undefined = offset === record.offset ? record.hash : input.start;
    // A failed re-upload leaves B2's earlier copy of the part, so its receipt stays until replaced.
    part.lease = { id: crypto.randomUUID(), until: Date.now() + 15 * 60_000, ...(start ? { start } : {}) };
    if (!record.parallel) { record.parallel = true; delete record.lease; recordChanged = true; }
    await Promise.all([
      storage.put(key, part),
      recordChanged ? storage.put(`lfs:${oid}`, record) : undefined,
    ]);
    return json({ uploadId: record.uploadId, partNumber, leaseId: part.lease.id, hash: start, size: record.size });
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
    let settledPart: LfsPart | undefined;
    if (!accepted) {
      if (part.etag) { settledPart = part; await storage.put(key, part); } else await storage.delete(key);
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
      settledPart = { partNumber: part.partNumber, etag: input.etag, length,
        ...(start ? { start } : {}), ...(end === record.size ? { digest: input.digest } : { end: input.hash }) };
      await storage.put<LfsPart>(key, settledPart);
    }
    // A part being sent again is passed only once that upload settles: its
    // bytes may replace the stored part, and the receipt must match them.
    const nextPart = (n: number) => settledPart && settledPart.partNumber === n
      ? Promise.resolve(settledPart) : storage.get<LfsPart>(partKey(oid, n));
    for (let next = await nextPart(record.partCount + 1);
      next?.etag && next.length && !(next.lease && next.lease.until > Date.now());
      next = await nextPart(record.partCount + 1)) {
      if (!sameHashState(next.start, record.hash)) {
        await cleanupLfs(storage, await this.ensureBucket(), this.accounting, repoId, oid, record,
          (work) => this.withCountLock(work));
        return new Response("LFS SHA-256 mismatch", { status: 422 });
      }
      record.offset += next.length; record.partCount++;
      if (record.offset === record.size) { record.digest = next.digest; delete record.hash; } else record.hash = next.end;
    }
    if (accepted) await this.extendReservation(repoId, oid, record);
    await storage.put(`lfs:${oid}`, record);
    if (accepted && record.offset === record.size && !record.verified) return this.completeUpload(repoId, oid, record);
    return json(record);
  }

  /**
   * Publishes a tus upload from its stored receipts so a later HEAD can retry.
   * The PATCH requests hashed the bytes they stored, so a wrong digest
   * discards the upload before B2 assembles it.
   */
  private async completeUpload(repoId: string, oid: string, record: Record): Promise<Response> {
    if (record.verified) return json(record);
    const { uploadId } = record;
    if (record.offset !== record.size || !uploadId || record.partCount === 0 || !record.digest)
      return new Response("Upload incomplete", { status: 409 });
    const bucket = await this.ensureBucket();
    if (record.digest !== oid) {
      await cleanupLfs(this.state.storage, bucket, this.accounting, repoId, oid, record,
        (work) => this.withCountLock(work));
      return new Response("LFS SHA-256 mismatch", { status: 422 });
    }
    const key = lfsKey(repoId, oid);
    return this.publish(repoId, oid, record, async () => {
      // Every part up to the accepted offset has a receipt.
      const parts = [...(await this.state.storage.list<LfsPart>({ prefix: partPrefix(oid) })).values()]
        .filter(p => p.partNumber <= record.partCount).sort((a, b) => a.partNumber - b.partNumber)
        .map(({ partNumber, etag }) => ({ partNumber, etag: etag! }));
      try {
        return await bucket.resumeMultipartUpload(key, uploadId).complete(parts, record.size);
      } catch (error) {
        // B2 may have assembled the object before its completion response was lost.
        const existing = await bucket.head(key);
        if (existing?.size === record.size && existing.versionId) return existing;
        throw error;
      }
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
    const hasParts = record.partCount > 0 || record.parallel === true;
    delete record.hash; delete record.lease;
    const parts = hasParts ? await storage.list({ prefix: partPrefix(oid) }) : undefined;
    await Promise.all([
      storage.put(`lfs:${oid}`, record),
      parts?.size ? storage.delete([...parts.keys()]) : undefined,
      scheduleGitMaintenance(storage, Date.now() + 60_000),
    ]);
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
    const object = await (await this.ensureBucket()).head(lfsKey(repoId, oid), undefined, { checksum: true });
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
    let skippedBusy = false;
    let collectedCount = 0;
    for (const [key] of unreferenced.slice(0, LFS_COLLECTION_BATCH)) {
      const oid = key.slice(4);
      if (this.mediaQueues.has(oid)) {
        skippedBusy = true;
        continue;
      }
      await this.serializeOid(oid, async () => {
        const current = await storage.get<Record>(key);
        if (!current?.verified || (current.touchedAt ?? 0) + LFS_COLLECTION_GRACE_MS > now) return;
        // Unpublish first; if deletion stops halfway, the expired reservation is
        // cleaned up like an abandoned upload.
        const abandoned = { ...current, verified: false, expiresAt: 0 };
        await storage.put(key, abandoned);
        await cleanupLfs(storage, this.objectBucket(), this.accounting, repoId, oid, abandoned,
          (work) => this.withCountLock(work));
        collectedCount++;
      });
    }
    if (collectedCount) console.info("Git LFS objects collected", { repoId, count: collectedCount });
    if (unreferenced.length > LFS_COLLECTION_BATCH || skippedBusy) return true;
    await storage.put("lfsCollectionCheckedAt", now);
    return false;
  }

  /**
   * Removes Git objects that became unreachable, such as a deleted branch's
   * commits. Reachability changes only with a push. A failed attempt leaves
   * every reachable object readable, and the next one waits an hour.
   */
  private async collectHistory(repoId: string): Promise<void> {
    const storage = this.state.storage;
    const pushed = await storage.get<number>("lastPushFinishedAt") ?? 0;
    if (pushed <= (await storage.get<number>("historyCollectedAt") ?? 0)) return;
    const retryAt = await storage.get<number>("historyCollectionAt") ?? 0;
    // An earlier alarm may have taken the place of the retry's.
    if (Date.now() < retryAt) { await scheduleGitMaintenance(storage, retryAt); return; }
    try {
      const collected = await collectUnreachableHistory(this.objectBucket(), repoId);
      if (collected) {
        console.info("Git history collected", { repoId, ...collected });
        // Deleted keys keep old B2 versions until the version sweep removes them.
        await storage.put("gitGcPending", true);
        if (this.accounting) await this.settleHistory(repoId, await this.gitBytes(repoId, new GitObjectStore(this.objectBucket())));
      }
      await storage.put("historyCollectedAt", pushed);
    } catch (error) {
      const retryAt = Date.now() + 60 * 60_000;
      await storage.put("historyCollectionAt", retryAt);
      await scheduleGitMaintenance(storage, retryAt);
      console.error("Git history collection failed", { repoId, error });
    }
  }

  alarm(): Promise<void> {
    return this.enqueue(async () => {
      this.repoCache = undefined;
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
      for (const [key] of records) {
        try {
          const oid = key.slice(4);
          // Serialize maintenance for each OID with concurrent media requests and
          // re-read the record so an upload that verified or renewed meanwhile is kept.
          await this.serializeOid(oid, async () => {
            const current = await storage.get<Record>(key);
            if (!current) return;
            if (!current.verified && current.expiresAt <= Date.now()) {
              await cleanupLfs(storage, this.objectBucket(), this.accounting, repoId, oid, current,
                (work) => this.withCountLock(work));
            } else if (current.verified && current.versionId && (fullSweep || !current.gcComplete)) {
              await this.objectBucket().pruneVersions?.(lfsKey(repoId, oid), [current.versionId]);
              await storage.put(key, { ...current, gcComplete: true });
            }
          });
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
      await this.collectHistory(repoId);
      try {
        if (await storage.get<boolean>("gitGcPending")) {
          await this.objectBucket().pruneGitVersions?.(`${gitRepositoryPrefix(repoId)}/`);
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
