import { createGitFs } from "git-fs-s3";
import {
  applyReceivePack,
  ensureRepoInitialized,
  handleInfoRefs,
  handleUploadPack,
  parseReceivePackBody,
  receivePackResponse,
} from "git-fs-s3/http";
import { MAX_GIT_NEGOTIATION_BYTES, MAX_GIT_PUSH_BYTES } from "@beutl/core";
import { GitObjectStore, type GitObjectBucket } from "./git-object-store";

// git-fs-s3's HTTP handlers and isomorphic-git build full packs in memory.
// Keep the Git history small; media must go through LFS.
const MAX_GIT_REPOSITORY_BYTES = 16 * 1024 * 1024;
// Leave room below the object adapter's 10,000-entry listing ceiling, including
// directories. Rejected pushes must leave the repository readable and deletable.
const MAX_GIT_REPOSITORY_OBJECTS = 9_000;
const MAX_GIT_REPOSITORY_REFS = 128;
const GITDIR = "/repo.git";

function incomingGitObjectBytes(pack: Uint8Array): number {
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

/** Opens the bare repository, writing HEAD/config the first time it is used. */
async function openRepository(bucket: GitObjectBucket, repoId: string) {
  const store = new GitObjectStore(bucket);
  const prefix = `git/repos/${repoId}`;
  const fs = createGitFs(store, { prefix });
  const repo = { fs, gitdir: GITDIR, cache: {} };
  await ensureRepoInitialized(repo);
  return { store, prefix, fs, repo };
}

export async function initializeGitRepository(bucket: GitObjectBucket, repoId: string): Promise<void> {
  await openRepository(bucket, repoId);
}

export type GitService = "git-upload-pack" | "git-receive-pack";

export function isGitService(value: string | undefined): value is GitService {
  return value === "git-upload-pack" || value === "git-receive-pack";
}

export async function advertiseGitRefs(bucket: GitObjectBucket, repoId: string, service: GitService): Promise<Response> {
  const { repo } = await openRepository(bucket, repoId);
  return response(await handleInfoRefs(repo, { service }));
}

export async function uploadGitPack(request: Request, bucket: GitObjectBucket, repoId: string): Promise<Response> {
  // Reject an oversized body before any repository storage I/O.
  const body = await readBodyAtMost(request, MAX_GIT_NEGOTIATION_BYTES);
  const { store, prefix, fs, repo } = await openRepository(bucket, repoId);
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

/** The caller must hold write scope; reserveHistory admits the push against account storage. */
export async function receiveGitPack(
  request: Request, bucket: GitObjectBucket, repoId: string,
  reserveHistory?: (maxAdditionalBytes: number) => Promise<boolean>,
): Promise<Response> {
  const body = await readBodyAtMost(request, MAX_GIT_PUSH_BYTES);
  const { store, prefix, repo } = await openRepository(bucket, repoId);
  const parsed = parseReceivePackBody(body);
  let additionalBytes: number;
  try { additionalBytes = incomingGitObjectBytes(parsed.packData); }
  catch {
    // Malformed pack metadata is a client protocol error, returned as HTTP 400.
    return new Response("Invalid Git pack header", { status: 400 });
  }
  if (parsed.packData.byteLength > 0 &&
      new DataView(parsed.packData.buffer, parsed.packData.byteOffset).getUint32(8) === 0) {
    // Native Git can send a checksum-bearing, zero-object pack for a ref-only
    // creation. Validate it, then avoid retaining a useless pack/index pair.
    if (parsed.packData.byteLength !== 32) return new Response("Invalid empty Git pack", { status: 400 });
    const checksum = new Uint8Array(await crypto.subtle.digest("SHA-1", Uint8Array.from(parsed.packData.subarray(0, 12))));
    if (!checksum.every((byte, index) => byte === parsed.packData[12 + index])) {
      return new Response("Invalid empty Git pack checksum", { status: 400 });
    }
    parsed.packData = new Uint8Array();
    additionalBytes = 0;
  }
  const refs = await store.list(`${prefix}/repo.git/refs/`);
  const projectedRefs = new Set(refs.objects.map((ref) => ref.key));
  for (const update of parsed.refUpdates) {
    if (update.newOid !== "0".repeat(40)) projectedRefs.add(`${prefix}/repo.git/${update.refName}`);
  }
  // Do not credit deletions until they succeed: a stale deletion must not
  // create room for new refs in the same request. Existing refs stay mutable.
  if (projectedRefs.size > refs.objects.length && projectedRefs.size > MAX_GIT_REPOSITORY_REFS) {
    return new Response("Git repository ref count limit exceeded", { status: 413 });
  }
  const objects = await store.list(`${prefix}/repo.git/objects/`);
  const allObjects = await store.list(`${prefix}/repo.git/`);
  const storedBytes = allObjects.objects.reduce((size, object) => size + object.size, 0);
  additionalBytes += Math.max(0, projectedRefs.size - refs.objects.length) * 41;
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
