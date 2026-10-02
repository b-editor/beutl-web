import { handleGitHttp } from "./git-http";
import { handleLfsBatch, handleLfsVerify, pruneExpiredLfs, type GitDurableStorage, type LfsEnvironment, type LfsRecord } from "./lfs";
import type { GitObjectBucket } from "./git-object-store";
import { S3GitObjectBucket, type GitS3Environment } from "./s3-object-store";
import type { GitScope } from "./tokens";
import { abortMultipart, handleMultipart } from "./multipart";

interface State {
  storage: GitDurableStorage;
}

interface Environment extends LfsEnvironment, GitS3Environment {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const OID = /^[0-9a-f]{64}$/u;

/** All storage and Git operations for one repository pass through this queue. */
export class GitRepositoryDurableObject {
  private tail: Promise<unknown> = Promise.resolve();
  private bucket?: GitObjectBucket;

  constructor(
    private readonly state: State, private readonly env: Environment,
    testBucket?: GitObjectBucket,
  ) { this.bucket = testBucket; }

  private objectBucket(): GitObjectBucket {
    return this.bucket ??= new S3GitObjectBucket(this.env);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async fetch(request: Request): Promise<Response> {
    return this.enqueue(() => this.handle(request));
  }

  async alarm(): Promise<void> {
    await this.enqueue(async () => {
      const repoId = await this.state.storage.get<string>("repoId");
      if (repoId && UUID.test(repoId)) {
        await pruneExpiredLfs(this.state.storage, this.objectBucket(), repoId);
      }
    });
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
    if (request.method === "DELETE" && path === "/internal/git/cleanup") {
      if (scope !== "admin") return new Response("Forbidden", { status: 403 });
      await this.state.storage.put("deleted", true);
      const records = await this.state.storage.list<LfsRecord>({ prefix: "lfs:" });
      for (const [key, record] of records) {
        if (record.kind === "multipart" && !record.verified) {
          await abortMultipart(bucket, this.state.storage, repoId, key.slice(4), record);
        }
      }
      await this.deletePrefix(bucket, `git/repos/${repoId}/`);
      await this.deletePrefix(bucket, `git-lfs/repos/${repoId}/`);
      for (const key of records.keys()) await this.state.storage.delete(key);
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
        );
      }
      const verify = /^info\/lfs\/objects\/([0-9a-f]{64})\/verify$/u.exec(operation);
      if (request.method === "POST" && verify && OID.test(verify[1])) {
        if (scope !== "write") return new Response("Forbidden", { status: 403 });
        return await handleLfsVerify(request, bucket, this.state.storage, repoId, verify[1]);
      }
      const multipart = /^info\/lfs\/objects\/([0-9a-f]{64})\/multipart(?:\/(.*))?$/u.exec(operation);
      if (multipart) {
        if (scope !== "write") return new Response("Forbidden", { status: 403 });
        return await handleMultipart(
          request, bucket, this.state.storage, repoId, multipart[1], multipart[2] ?? "",
        );
      }
      if (request.method === "POST" && operation === "git-receive-pack") {
        // git-fs-s3 v0.3.5 names incoming packs with Date.now(). Even with
        // serialization, two pushes in the same millisecond could overwrite
        // a previous pack. Persist the last completion time across DO restarts.
        const last = await this.state.storage.get<number>("lastPushFinishedAt") ?? 0;
        if (Date.now() <= last) {
          await new Promise((resolve) => setTimeout(resolve, last - Date.now() + 1));
        }
        try {
          return await handleGitHttp(request, bucket, repoId, scope as GitScope);
        } finally {
          await this.state.storage.put("lastPushFinishedAt", Date.now());
        }
      }
      return await handleGitHttp(request, bucket, repoId, scope as GitScope);
    } catch (error) {
      if (error instanceof RangeError) return new Response(error.message, { status: 413 });
      throw error;
    }
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
