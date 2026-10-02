import { createGitFs } from "git-fs-s3";
import {
  applyReceivePack,
  ensureRepoInitialized,
  handleInfoRefs,
  handleUploadPack,
  parseReceivePackBody,
  receivePackResponse,
} from "git-fs-s3/http";
import type { GitScope } from "./tokens";
import { R2GitObjectStore, type GitR2Bucket } from "./r2-object-store";

// git-fs-s3's HTTP handlers and isomorphic-git build full packs in memory.
// Keep the Git history small; media must go through LFS.
export const MAX_GIT_PUSH_BYTES = 8 * 1024 * 1024;
export const MAX_GIT_REPOSITORY_BYTES = 16 * 1024 * 1024;
const MAX_GIT_NEGOTIATION_BYTES = 64 * 1024;
const GITDIR = "/repo.git";

export async function readBodyAtMost(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new RangeError("Git request body is too large");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function response(result: { status: number; headers: Record<string, string>; body: Uint8Array }): Response {
  return new Response(result.body as Uint8Array<ArrayBuffer>, {
    status: result.status,
    headers: result.headers,
  });
}

export async function handleGitHttp(
  request: Request,
  bucket: GitR2Bucket,
  repoId: string,
  scope: GitScope,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const base = `/api/v3/git/${repoId}.git/`;
  if (!path.startsWith(base)) return new Response("Not found", { status: 404 });
  const operation = path.slice(base.length);
  const store = new R2GitObjectStore(bucket);
  const prefix = `git/repos/${repoId}`;
  const fs = createGitFs(store, { prefix });
  const repo = { fs, gitdir: GITDIR, cache: {} };
  await ensureRepoInitialized(repo);

  if (request.method === "GET" && operation === "info/refs") {
    const service = new URL(request.url).searchParams.get("service");
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      return new Response("Unsupported Git service", { status: 400 });
    }
    if (service === "git-receive-pack" && scope !== "write") {
      return new Response("Forbidden", { status: 403 });
    }
    return response(await handleInfoRefs(repo, { service }));
  }

  if (request.method === "POST" && operation === "git-upload-pack") {
    const body = await readBodyAtMost(request, MAX_GIT_NEGOTIATION_BYTES);
    const objects = await store.list(`${prefix}/repo.git/objects/`);
    if (objects.objects.reduce((size, object) => size + object.size, 0) > MAX_GIT_REPOSITORY_BYTES) {
      return new Response("Git history exceeds the serving limit", { status: 413 });
    }
    const result = await handleUploadPack(repo, body, {
      beforeWalk: () => fs.detectLooseObjects(GITDIR),
    });
    if (result.body.byteLength > MAX_GIT_REPOSITORY_BYTES * 2) {
      return new Response("Git pack exceeds the serving limit", { status: 413 });
    }
    return response(result);
  }

  if (request.method === "POST" && operation === "git-receive-pack") {
    if (scope !== "write") return new Response("Forbidden", { status: 403 });
    const body = await readBodyAtMost(request, MAX_GIT_PUSH_BYTES);
    const parsed = parseReceivePackBody(body);
    const objects = await store.list(`${prefix}/repo.git/objects/`);
    const storedBytes = objects.objects.reduce((size, object) => size + object.size, 0);
    if (storedBytes + parsed.packData.byteLength * 2 > MAX_GIT_REPOSITORY_BYTES) {
      return new Response("Git history quota exceeded; track media with Git LFS", { status: 413 });
    }
    const { results } = await applyReceivePack(repo, parsed, { repack: false });
    return response(receivePackResponse(results));
  }

  return new Response("Not found", { status: 404 });
}
