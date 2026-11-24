import { Buffer } from "node:buffer";
import {
  FLUSH,
  GitProtocolError,
  isGitRefName,
  parsePktLines,
  parseReceivePackBody,
  pktLine,
  receivePackResponse,
  ZERO_OID,
  type RefUpdate,
} from "./git-protocol";
import { MAX_GIT_NEGOTIATION_BYTES, MAX_GIT_PUSH_BYTES } from "@beutl/core";
import { GitObjectStore, type GitObjectBucket, type ListResult, type ObjectStore } from "./git-object-store";
import { GitFileSystem } from "./git-filesystem";
import { readRefSnapshot } from "./git-refs";
import { GitObjectReader, type PackedGitEntry } from "./object-reader";
import { collectGitObjects, GitObjectGraphError } from "./object-graph";
import { createGitPack, gitIndexBytes, gitPackResponse } from "./pack-writer";
import { GitPackLimitError, GitPackValidationError, validateAndIndexGitPack, type ValidatedGitObject } from "./pack-validation";

// Incoming pack validation reads full packs in memory.
// Keep the Git history small; media must go through LFS.
export const MAX_GIT_REPOSITORY_BYTES = 16 * 1024 * 1024;
// Leave room below the object adapter's 10,000-entry listing ceiling, including
// directories. Rejected pushes must leave the repository readable and deletable.
const MAX_GIT_REPOSITORY_OBJECTS = 9_000;
const MAX_GIT_REPOSITORY_REFS = 128;
const GITDIR = "/repo.git";
const INITIAL_FILES = [
  ["config", "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = true\n"],
  ["HEAD", "ref: refs/heads/main\n"],
] as const;
type CheckedRefUpdate = RefUpdate & { error?: string };
type RepositoryOptions = { store?: ObjectStore; objects?: ListResult["objects"]; initialized?: boolean };
type ReceivePackOptions = RepositoryOptions & {
  beforeWrite?: () => Promise<void>;
  onSettled?: (result: { wrote: boolean; bytes: number }) => void;
};

export const gitRepositoryPrefix = (repoId: string) => `git/repos/${repoId}`;

function incomingGitPackCount(pack: Uint8Array): number {
  if (pack.byteLength === 0) return 0; // Ref-only update/deletion.
  if (pack.byteLength < 32 || new TextDecoder().decode(pack.subarray(0, 4)) !== "PACK") {
    throw new Error("Invalid Git pack header");
  }
  const header = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (![2, 3].includes(header.getUint32(4))) throw new Error("Unsupported Git pack version");
  return header.getUint32(8);
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

/**
 * The bare repository as stored, without writing anything to it. With loose
 * object hints, reads skip looking for loose objects once a listing shows none.
 */
export function readGitRepository(bucket: GitObjectBucket, repoId: string,
  { store = new GitObjectStore(bucket), looseObjectHints = false }: { store?: ObjectStore; looseObjectHints?: boolean } = {}) {
  const prefix = gitRepositoryPrefix(repoId);
  const fs = new GitFileSystem(store, prefix, looseObjectHints);
  return { store, prefix, fs, repo: { fs, gitdir: GITDIR, cache: {} } };
}

async function finishWrites(writes: Promise<void>[]): Promise<void> {
  try { await Promise.all(writes); }
  catch (error) {
    // The repository queue still owns all of these writes on failure.
    await Promise.allSettled(writes);
    throw error;
  }
}

/** Writes missing bare repository metadata from the history accounting listing. */
export async function initializeGitRepository(bucket: GitObjectBucket, repoId: string,
  options: RepositoryOptions = {}, beforeWrite?: () => Promise<void>) {
  const store = options.store ?? new GitObjectStore(bucket);
  const prefix = gitRepositoryPrefix(repoId), root = `${prefix}${GITDIR}/`;
  let objects = options.objects ?? (await store.list(`${prefix}/`)).objects;
  // Check both files independently so retrying a partial initialization
  // preserves the default branch of an existing repository.
  const missing = options.initialized ? [] : INITIAL_FILES.filter(([name]) => !objects.some(({ key }) => key === root + name))
    .map(([name, contents]) => ({ key: root + name, data: Buffer.from(contents) }));
  if (missing.length) {
    await beforeWrite?.();
    await finishWrites(missing.map(({ key, data }) => store.put(key, data)));
    objects = [...objects, ...missing.map(({ key, data }) => ({ key, size: data.byteLength }))];
  }
  return { objects, bytes: objects.reduce((bytes, object) => bytes + object.size, 0), wrote: missing.length > 0 };
}

async function openRepository(bucket: GitObjectBucket, repoId: string, options: RepositoryOptions,
  beforeWrite?: () => Promise<void>) {
  const opened = readGitRepository(bucket, repoId, { store: options.store });
  const { store, prefix, fs } = opened, root = `${prefix}${GITDIR}/`;
  const { objects, bytes: storedBytes, wrote } = await initializeGitRepository(bucket, repoId, { ...options, store }, beforeWrite);
  const refSizes = new Map<string, number>();
  const packIndexNames: string[] = [];
  const objectsPrefix = `${root}objects/`, packPrefix = `${objectsPrefix}pack/`;
  let objectBytes = 0, objectCount = 0, lastPackTime = 0;
  let hasLooseObjects = false, packedRefsSize: number | undefined;
  for (const { key, size } of objects) {
    if (key.startsWith(`${root}refs/`)) refSizes.set(key, size);
    if (key === `${root}packed-refs`) packedRefsSize = size;
    if (!key.startsWith(objectsPrefix)) continue;
    objectCount++;
    objectBytes += size;
    if (/^[0-9a-f]{2}\/[0-9a-f]{38}$/u.test(key.slice(objectsPrefix.length))) hasLooseObjects = true;
    if (!key.startsWith(packPrefix)) continue;
    const name = key.slice(packPrefix.length);
    if (name.endsWith(".idx") && !name.includes("/")) packIndexNames.push(name);
    const time = /^(?:recv|pack)-(\d+)\.pack$/u.exec(name)?.[1];
    if (time) lastPackTime = Math.max(lastPackTime, Number(time));
  }
  fs.setNoLooseObjects(!hasLooseObjects);
  return { ...opened, root, refSizes, packedRefsSize, storedBytes, objectBytes, objectCount, lastPackTime,
    packIndexNames: packIndexNames.sort(), wrote };
}

export type GitService = "git-upload-pack" | "git-receive-pack";

export function isGitService(value: string | undefined): value is GitService {
  return value === "git-upload-pack" || value === "git-receive-pack";
}

export async function advertiseGitRefs(bucket: GitObjectBucket, repoId: string, service: GitService,
  options: RepositoryOptions = {}): Promise<Response> {
  const opened = await openRepository(bucket, repoId, options);
  const { store, root, refSizes, packedRefsSize, packIndexNames } = opened;
  const [{ refs }, headBytes] = await Promise.all([
    readRefSnapshot(store, root, { refKeys: [...refSizes.keys()], hasPackedRefs: packedRefsSize !== undefined }),
    store.get(`${root}HEAD`),
  ]);
  const head = headBytes ? Buffer.from(headBytes).toString("utf8").trim() : "";
  const target = head.startsWith("ref: ") && isGitRefName(head.slice(5)) ? head.slice(5) : undefined;
  const headOid = target ? refs.get(target) : /^[0-9a-f]{40}$/u.test(head) ? head : undefined;
  const capabilities = service === "git-upload-pack"
    ? ["multi_ack_detailed", "thin-pack", "side-band", "side-band-64k", "ofs-delta",
      "allow-tip-sha1-in-want", "allow-reachable-sha1-in-want", ...(target ? [`symref=HEAD:${target}`] : [])]
    : ["report-status", "delete-refs", "ofs-delta", "side-band-64k"];
  const entries: [string, string][] = headOid ? [["HEAD", headOid]] : [];
  const reader = new GitObjectReader(opened, { packIndexNames });
  for (const [name, oid] of [...refs].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (!isGitRefName(name)) throw new Error("Invalid stored Git ref");
    entries.push([name, oid]);
    if (service === "git-upload-pack" && name.startsWith("refs/tags/")) {
      let peeled = oid;
      while ((await reader.info(peeled))?.type === "tag") {
        const object = /^object ([0-9a-f]{40})\n/u.exec(Buffer.from(await reader.read(peeled)).toString("utf8"))?.[1];
        if (!object) throw new Error("Invalid Git tag");
        peeled = object;
      }
      if (peeled !== oid) entries.push([`${name}^{}`, peeled]);
    }
  }
  if (!entries.length) entries.push(["capabilities^{}", ZERO_OID]);
  const body = Buffer.concat([pktLine(`# service=${service}\n`), FLUSH, ...entries.map(([name, oid], index) =>
    pktLine(`${oid} ${name}${index === 0 ? `\0${capabilities.join(" ")}` : ""}\n`)), FLUSH]);
  return new Response(body, { headers: { "Content-Type": `application/x-${service}-advertisement`, "Cache-Control": "no-cache" } });
}

// A repository with loose objects reads storage for every unknown have. Haves
// past this many in one request count as unknown: the pack stays correct, at
// worst larger. Git sends its newest commits first, so shared ones come early.
const MAX_CHECKED_HAVES = 1024;
const encodePktLines = (lines: (string | null)[]) => Buffer.concat(lines.map((line) => line === null ? FLUSH : pktLine(line)));
const haveOf = (line: string | null) => line?.startsWith("have ") ? line.slice(5, 45) : undefined;

/** The haves this repository also holds, in request order; their ancestry is common too. */
async function commonObjects(reader: GitObjectReader, haves: string[]): Promise<string[]> {
  const common: string[] = [];
  for (const oid of [...new Set(haves)].slice(0, MAX_CHECKED_HAVES)) {
    if (await reader.info(oid)) common.push(oid);
  }
  return common;
}

export async function uploadGitPack(request: Request, bucket: GitObjectBucket, repoId: string,
  options: RepositoryOptions = {}): Promise<Response> {
  const body = await readBodyAtMost(request, MAX_GIT_NEGOTIATION_BYTES);
  let lines: (string | null)[];
  try { lines = parsePktLines(body); }
  catch (error) { if (error instanceof GitProtocolError) return new Response(error.message, { status: 400 }); throw error; }
  const opened = await openRepository(bucket, repoId, options);
  if (opened.objectBytes > MAX_GIT_REPOSITORY_BYTES)
    return new Response("Git history exceeds the serving limit", { status: 413 });
  const wants = lines.filter((line): line is string => line?.startsWith("want ") ?? false).map((line) => line.slice(5, 45));
  const haves = lines.map(haveOf).filter((oid): oid is string => oid !== undefined);
  if ([...wants, ...haves].some((oid) => !/^[0-9a-f]{40}$/u.test(oid)))
    return new Response("Invalid Git object ID", { status: 400 });
  const capabilities = new Set(lines.find((line) => line?.startsWith("want "))?.trimEnd().split(" ").slice(2) ?? []);
  const multiAck = capabilities.has("multi_ack_detailed"), done = lines.some((line) => line?.startsWith("done"));
  const reply = (text: string[]) => new Response(encodePktLines(text) as Uint8Array<ArrayBuffer>, {
    headers: { "Content-Type": "application/x-git-upload-pack-result", "Cache-Control": "no-cache" },
  });
  if (!wants.length || (haves.length && !multiAck && !done)) return reply(["NAK\n"]);
  const reader = new GitObjectReader(opened, { packIndexNames: opened.packIndexNames }), common = await commonObjects(reader, haves);
  if (haves.length && multiAck && !done) return reply([...common.map((oid) => `ACK ${oid} common\n`), "NAK\n"]);
  const have = await collectGitObjects(reader, common);
  const want = await collectGitObjects(reader, wants, { exclude: have });
  const selected = new Map<string, PackedGitEntry>(), pending = [...want];
  const thin = capabilities.has("thin-pack");
  for (let oid = pending.pop(); oid !== undefined; oid = pending.pop()) {
    if (selected.has(oid)) continue;
    const entry = await reader.packed(oid); selected.set(oid, entry);
    if (entry.base && (!thin || !have.has(entry.base))) pending.push(entry.base);
  }
  const pack = createGitPack([...selected].map(([oid, entry]) => ({ oid, entry })));
  if (pack.byteLength > MAX_GIT_REPOSITORY_BYTES * 2)
    return new Response("Git pack exceeds the serving limit", { status: 413 });
  return gitPackResponse(pack, pktLine(common.length ? `ACK ${common.at(-1)}\n` : "NAK\n"),
    capabilities.has("side-band-64k") ? 65515 : capabilities.has("side-band") ? 995 : null);
}

/** The caller must hold write scope; reserveHistory admits the push against account storage. */
export async function receiveGitPack(
  request: Request, bucket: GitObjectBucket, repoId: string,
  reserveHistory?: (maxAdditionalBytes: number) => Promise<boolean>,
  { beforeWrite, onSettled, ...options }: ReceivePackOptions = {},
): Promise<Response> {
  const body = await readBodyAtMost(request, MAX_GIT_PUSH_BYTES);
  let parsed: ReturnType<typeof parseReceivePackBody>;
  try { parsed = parseReceivePackBody(body); }
  catch (error) { if (error instanceof GitProtocolError) return new Response(error.message, { status: 400 }); throw error; }
  let readyToWrite: Promise<void> | undefined;
  const beforeFirstWrite = () => readyToWrite ??= beforeWrite?.() ?? Promise.resolve();
  const repository = await openRepository(bucket, repoId, options, beforeFirstWrite);
  const { store, root, refSizes, packedRefsSize } = repository;
  let { storedBytes, wrote } = repository;
  const finish = (response: Response) => {
    onSettled?.({ wrote, bytes: storedBytes });
    return response;
  };
  // The Durable Object holds the single-writer queue from this comparison
  // through the ref writes. Stale retries must not store another pack.
  const { refs, packedRefs } = await readRefSnapshot(store, root, {
    refKeys: [...refSizes.keys()], hasPackedRefs: packedRefsSize !== undefined,
  });
  const updates: CheckedRefUpdate[] = parsed.refUpdates.map((update) => ({ ...update,
    error: (refs.get(update.refName) ?? ZERO_OID) !== update.oldOid ? "stale ref" : undefined,
  }));
  if (updates.every((update) => update.error)) return finish(receivePackResponse(updates, parsed.capabilities));
  let count: number;
  try { count = incomingGitPackCount(parsed.packData); }
  catch {
    // Malformed pack metadata is a client protocol error, returned as HTTP 400.
    return finish(new Response("Invalid Git pack header", { status: 400 }));
  }
  if (parsed.packData.byteLength > 0 && count === 0) {
    // Native Git can send a checksum-bearing, zero-object pack for a ref-only
    // creation. Validate it, then avoid retaining a useless pack/index pair.
    if (parsed.packData.byteLength !== 32) return finish(new Response("Invalid empty Git pack", { status: 400 }));
    const checksum = new Uint8Array(await crypto.subtle.digest("SHA-1", Uint8Array.from(parsed.packData.subarray(0, 12))));
    if (!checksum.every((byte, index) => byte === parsed.packData[12 + index])) {
      return finish(new Response("Invalid empty Git pack checksum", { status: 400 }));
    }
    parsed.packData = new Uint8Array();
  }
  const packBytes = parsed.packData.length ? parsed.packData.byteLength + gitIndexBytes(count) : 0;
  const refGrowth = (changes: CheckedRefUpdate[]) => changes.reduce((bytes, { refName, newOid, error }) =>
    !error && newOid !== ZERO_OID ? bytes + Math.max(0, 41 - (refSizes.get(root + refName) ?? 0)) : bytes, 0);
  const projectedRefs = new Set(refs.keys());
  for (const { refName, newOid, error } of updates) {
    if (!error && newOid !== ZERO_OID) projectedRefs.add(refName);
  }
  // Do not credit deletions until they succeed: a stale deletion must not
  // create room for new refs in the same request. Existing refs stay mutable.
  if (projectedRefs.size > refs.size && projectedRefs.size > MAX_GIT_REPOSITORY_REFS) {
    return finish(new Response("Git repository ref count limit exceeded", { status: 413 }));
  }
  if (packBytes && repository.objectCount + 2 > MAX_GIT_REPOSITORY_OBJECTS) {
    return finish(new Response("Git history object count limit exceeded", { status: 413 }));
  }
  if (storedBytes + packBytes + refGrowth(updates) > MAX_GIT_REPOSITORY_BYTES) {
    return finish(new Response("Git history quota exceeded; track media with Git LFS", { status: 413 }));
  }
  let index: Uint8Array<ArrayBuffer>;
  try {
    if (count > MAX_GIT_REPOSITORY_OBJECTS) throw new GitPackLimitError("Git pack has too many objects");
    const reader = new GitObjectReader(repository, { packIndexNames: repository.packIndexNames });
    const validated = await validateAndIndexGitPack(parsed.packData, MAX_GIT_REPOSITORY_BYTES, reader);
    index = validated.index;
    if (parsed.packData.length && index.byteLength !== gitIndexBytes(count)) throw new Error("Git pack index is incomplete");
    await validateRefUpdates(updates, refs, reader, validated.objects);
  } catch (error) {
    if (!(error instanceof GitPackValidationError)) throw error;
    return finish(new Response(error instanceof GitPackLimitError ? error.message : "Invalid Git pack", {
      status: error instanceof GitPackLimitError ? 413 : 400,
    }));
  }
  const accepted = updates.filter(({ error }) => !error);
  if (!accepted.length) return finish(receivePackResponse(updates, parsed.capabilities));
  const deletedRefs = new Set(accepted.filter(({ newOid }) => newOid === ZERO_OID).map(({ refName }) => refName));
  const deletes = [...deletedRefs].map((name) => root + name).filter((key) => refSizes.has(key));
  const puts = accepted.filter(({ newOid }) => newOid !== ZERO_OID).map(({ refName, newOid }) =>
    ({ key: root + refName, data: Buffer.from(`${newOid}\n`) }));
  const remainingPackedRefs = packedRefs.filter(({ name }) => name === undefined || !deletedRefs.has(name));
  const packed = remainingPackedRefs.length < packedRefs.length
    ? Buffer.from(remainingPackedRefs.map(({ text }) => text).join("\n")) : undefined;
  const packedDelta = packed ? packed.byteLength - (packedRefsSize ?? 0) : 0;
  const additionalBytes = packBytes + refGrowth(accepted) + Math.max(0, packedDelta);
  if (storedBytes + additionalBytes > MAX_GIT_REPOSITORY_BYTES) {
    return finish(new Response("Git history quota exceeded; track media with Git LFS", { status: 413 }));
  }
  if (additionalBytes > 0 && reserveHistory && !await reserveHistory(additionalBytes)) {
    return finish(new Response("Account storage quota exceeded", { status: 413 }));
  }
  if (packBytes || deletes.length || puts.length || packed) {
    await beforeFirstWrite();
    wrote = true;
  }
  if (parsed.packData.length) {
    // Preserve timestamped pack names for history collection, including pushes
    // in the same millisecond and clocks that move backwards.
    const time = Math.max(Date.now(), repository.lastPackTime + 1);
    const packKey = `${root}objects/pack/recv-${time}.pack`, indexKey = packKey.replace(/\.pack$/u, ".idx");
    try {
      await store.put(packKey, parsed.packData);
      await store.put(indexKey, index);
    } catch (error) {
      await store.delete(indexKey);
      await store.delete(packKey);
      throw error;
    }
    storedBytes += parsed.packData.byteLength + index.byteLength;
  }
  // A deleted ref can be the parent of a newly created ref. Finish the
  // deletions first so a failed delete cannot leave conflicting names.
  await finishWrites(deletes.map((key) => store.delete(key)));
  if (packed) {
    await store.put(`${root}packed-refs`, packed);
    storedBytes += packedDelta;
  }
  await finishWrites(puts.map(({ key, data }) => store.put(key, data)));
  for (const key of deletes) storedBytes -= refSizes.get(key)!;
  for (const { key, data } of puts) storedBytes += data.byteLength - (refSizes.get(key) ?? 0);
  return finish(receivePackResponse(updates, parsed.capabilities));
}

/** Validate against incoming and stored objects before making either the pack or refs visible. */
async function validateRefUpdates(updates: CheckedRefUpdate[], refs: Map<string, string>, stored: GitObjectReader,
  incoming: Map<string, ValidatedGitObject>) {
  const reader = {
    info: async (oid: string) => incoming.get(oid) ?? stored.info(oid),
    read: async (oid: string) => incoming.get(oid)?.data ?? stored.read(oid),
  };
  // Existing refs mark validated history, even if this push moves or deletes them.
  const verified = new Set(refs.values());
  for (const update of updates) {
    const { refName, newOid } = update;
    if (update.error) continue;
    if (newOid !== ZERO_OID) {
      const target = await reader.info(newOid);
      if (!target || (refName.startsWith("refs/heads/") && target.type !== "commit")) {
        update.error = "invalid target object"; continue;
      }
      if ([...refs.keys()].some((name) => name !== refName && (name.startsWith(`${refName}/`) || refName.startsWith(`${name}/`)))) {
        update.error = "ref name conflict"; continue;
      }
      try {
        const reachable = await collectGitObjects(reader, [newOid], { exclude: verified, compareParentTrees: true });
        for (const oid of reachable) verified.add(oid);
      } catch (error) {
        if (!(error instanceof GitObjectGraphError)) throw error;
        update.error = "incomplete object graph"; continue;
      }
      refs.set(refName, newOid);
    } else refs.delete(refName);
  }
}
