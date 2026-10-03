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
import { GitObjectStore, type GitObjectBucket } from "./git-object-store";

// git-fs-s3's HTTP handlers and isomorphic-git build full packs in memory.
// Keep the Git history small; media must go through LFS.
export const MAX_GIT_PUSH_BYTES = 8 * 1024 * 1024;
export const MAX_GIT_REPOSITORY_BYTES = 16 * 1024 * 1024;
// Leave room below the object adapter's 10,000-entry listing ceiling, including
// directories. Rejected pushes must leave the repository readable and deletable.
export const MAX_GIT_REPOSITORY_OBJECTS = 9_000;
const MAX_GIT_NEGOTIATION_BYTES = 64 * 1024;
const GITDIR = "/repo.git";

export function incomingGitObjectBytes(pack: Uint8Array): number {
  if (pack.byteLength === 0) return 0; // Ref-only update/deletion.
  if (pack.byteLength < 32 || new TextDecoder().decode(pack.subarray(0, 4)) !== "PACK") {
    throw new Error("Invalid Git pack header");
  }
  const header = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (![2, 3].includes(header.getUint32(4))) throw new Error("Unsupported Git pack version");
  // indexPack writes a v2 index: 8-byte header, 256 fanout entries, 28
  // bytes/object (SHA-1, CRC, offset), and two 20-byte checksums. The incoming
  // 8 MiB bound means offsets never need the additional 64-bit offset table.
  return pack.byteLength + 1072 + header.getUint32(8) * 28;
}

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
  bucket: GitObjectBucket,
  repoId: string,
  scope: GitScope,
  reserveHistory?: (maxAdditionalBytes: number) => Promise<boolean>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const base = `/api/v3/git/${repoId}.git/`;
  if (!path.startsWith(base)) return new Response("Not found", { status: 404 });
  const operation = path.slice(base.length);
  const store = new GitObjectStore(bucket);
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
      beforeWalk: async () => {
        await fs.detectLooseObjects(GITDIR);
        await fs.prefetchPacks(GITDIR);
      },
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
    let additionalBytes: number;
    try { additionalBytes = incomingGitObjectBytes(parsed.packData); }
    catch { return new Response("Invalid Git pack header", { status: 400 }); }
    const objects = await store.list(`${prefix}/repo.git/objects/`);
    const storedBytes = objects.objects.reduce((size, object) => size + object.size, 0);
    if (parsed.packData.byteLength > 0 && objects.objects.length + 2 > MAX_GIT_REPOSITORY_OBJECTS) {
      return new Response("Git history object count limit exceeded", { status: 413 });
    }
    if (storedBytes + additionalBytes > MAX_GIT_REPOSITORY_BYTES) {
      return new Response("Git history quota exceeded; track media with Git LFS", { status: 413 });
    }
    if (reserveHistory && !await reserveHistory(additionalBytes)) {
      return new Response("Account storage quota exceeded", { status: 413 });
    }
    const { results } = await applyReceivePack(repo, parsed, { repack: false });
    return response(receivePackResponse(results));
  }

  return new Response("Not found", { status: 404 });
}
